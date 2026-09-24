package team

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/nex-crm/wuphf/internal/action"
	"github.com/nex-crm/wuphf/internal/config"
)

// Silent credential re-mint.
//
// Composio's `uak_` session key is revocable: it dies on re-login and on
// expiry, and every integration in the office then fails with
// 401 UserApiKey_Unauthorized. The founder's instruction was that the user
// should never have to understand that — "the new key minting should
// automatically happen via cli".
//
// So: when the REST client sees Composio reject the stored credential, it asks
// this provider for a fresh one, exactly once, and retries the request once. If
// the CLI still holds a live session, a new project `ak_` key is minted,
// persisted, and the user sees nothing but their integration working. If the
// CLI session is dead too, no amount of local machinery can fix it — a browser
// login is required — and the provider fails, which is what lets the HTTP
// boundary swap the protocol error for a sentence and a button.
//
// Hang safety is the hard constraint here, because this runs on a request path:
//
//  1. composioCLILoggedIn() is a precondition. `composio dev init` only starts
//     an interactive login when it finds no stored session (verified in the CLI
//     0.2.31 binary: its init routine logs in only when the global key lookup
//     comes back empty), so requiring a stored session keeps it out of that
//     branch entirely.
//  2. The subprocess gets composioRemintDevInitTimeout as a hard wall clock,
//     enforced by exec.CommandContext, which kills it.
//  3. The subprocess gets no stdin, so any prompt hits EOF and fails fast.

var (
	// composioRemintDevInitTimeout bounds the `composio dev init` subprocess on
	// the request path. The mint is three HTTP calls; this is generous for them
	// and short enough that a wedged CLI cannot hold a user's request open.
	composioRemintDevInitTimeout = 25 * time.Second
	// composioRemintCooldown is how long a completed re-mint (success OR
	// failure) is served from cache. It converts a burst of failing requests
	// into one CLI invocation, and stops a permanently-dead CLI session from
	// being re-probed on every single request.
	composioRemintCooldown = 30 * time.Second
)

// errComposioSessionExpired is the provider's "cannot recover locally" result:
// the stored credential is dead AND the CLI session cannot mint a new one, so a
// human has to sign in through a browser. Diagnostic only — never user-facing.
var errComposioSessionExpired = errors.New("composio CLI session cannot mint a credential; browser sign-in required")

// registerComposioReauth wires this broker's re-mint provider into the action
// package, so EVERY Composio caller recovers — the integrations handlers, the
// capability registry, and the action registry an agent executes through — not
// only the surface that happened to be wired up.
func (b *Broker) registerComposioReauth() {
	action.SetComposioReauth(b.composioReauth)
}

// composioReauth is the action.ComposioReauthFunc implementation: single-flight
// + short-lived cache around one CLI re-mint.
func (b *Broker) composioReauth(ctx context.Context) (action.ComposioCredentials, error) {
	flow := &b.composioSignin
	flow.mu.Lock()
	// An interactive sign-in already has the CLI: joining it silently would
	// race two `composio` processes over the same session file. Let the
	// interactive flow finish and report the failure honestly this time round.
	switch flow.state.Status {
	case composioSigninStatusInstalling, composioSigninStatusAwaitingLogin, composioSigninStatusProvisioning:
		flow.mu.Unlock()
		return action.ComposioCredentials{}, errComposioSessionExpired
	}
	if done := flow.remintDone; done != nil {
		flow.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return action.ComposioCredentials{}, ctx.Err()
		}
		flow.mu.Lock()
		creds, err := flow.remintCreds, flow.remintErr
		flow.mu.Unlock()
		return creds, err
	}
	if !flow.remintAt.IsZero() && time.Since(flow.remintAt) < composioRemintCooldown {
		creds, err := flow.remintCreds, flow.remintErr
		flow.mu.Unlock()
		return creds, err
	}
	done := make(chan struct{})
	flow.remintDone = done
	flow.mu.Unlock()

	creds, err := b.composioRemint()

	flow.mu.Lock()
	flow.remintCreds, flow.remintErr, flow.remintAt = creds, err, time.Now()
	flow.remintDone = nil
	flow.mu.Unlock()
	close(done)
	return creds, err
}

// composioRemint mints and persists one fresh credential from the CLI session.
// Credentials never reach a log line or an error string.
func (b *Broker) composioRemint() (action.ComposioCredentials, error) {
	if !composioCLILoggedIn() {
		return action.ComposioCredentials{}, errComposioSessionExpired
	}
	creds, err := composioRemintCreds(currentComposioCredentials())
	if err != nil {
		return action.ComposioCredentials{}, err
	}
	if err := b.storeComposioCreds(creds); err != nil {
		// config.Save errors wrap OS errors carrying the user's home path.
		// Keep them out of anything user-facing; the log has the detail.
		log.Printf("composio re-mint: %v", err)
		return action.ComposioCredentials{}, errComposioSessionExpired
	}
	return creds, nil
}

// composioRemintCreds resolves a credential the CLI session can still produce,
// on a request-path budget.
//
// Order matters: a project `ak_` key first, because it is the documented,
// non-expiring auth and minting one is what makes this whole class of failure
// rare. The `uak_` fallback is accepted only when the CLI session file holds a
// DIFFERENT key from the one Composio just rejected — re-storing the same dead
// key would buy nothing but a second 401.
func composioRemintCreds(current action.ComposioCredentials) (action.ComposioCredentials, error) {
	if key, err := composioProvisionProjectKey(composioRemintDevInitTimeout); err == nil {
		return action.ComposioCredentials{APIKey: key}, nil
	}
	ud, err := readComposioUserData()
	if err != nil {
		return action.ComposioCredentials{}, errComposioSessionExpired
	}
	uak := strings.TrimSpace(ud.APIKey)
	org := strings.TrimSpace(ud.OrgID)
	if uak == "" || org == "" || uak == strings.TrimSpace(current.UserAPIKey) {
		return action.ComposioCredentials{}, errComposioSessionExpired
	}
	return action.ComposioCredentials{
		UserAPIKey: uak,
		OrgID:      org,
		ProjectID:  composioResolveProjectID(ud.BaseURL, uak, org),
	}, nil
}

// currentComposioCredentials snapshots what the office is authenticating with
// right now, so the re-mint can tell a genuinely new credential from the one
// that was just rejected.
func currentComposioCredentials() action.ComposioCredentials {
	return action.ComposioCredentials{
		APIKey:     config.ResolveComposioAPIKey(),
		UserAPIKey: config.ResolveComposioUserAPIKey(),
		OrgID:      config.ResolveComposioOrgID(),
		ProjectID:  config.ResolveComposioProjectID(),
	}
}

// storeComposioCreds persists a re-minted credential set, clearing the auth
// mode it did NOT use. That clearing is the point: leaving a revoked `uak_`
// trio behind an `ak_` key keeps a dead credential one config edit away from
// being used again, and leaves the file lying about how the office authenticates.
// Same load-modify-save under configMu as storeComposioAPIKey.
func (b *Broker) storeComposioCreds(creds action.ComposioCredentials) error {
	b.configMu.Lock()
	defer b.configMu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if key := strings.TrimSpace(creds.APIKey); key != "" {
		cfg.ComposioAPIKey = key
		cfg.ComposioUserAPIKey = ""
		cfg.ComposioOrgID = ""
		cfg.ComposioProjectID = ""
	} else {
		cfg.ComposioAPIKey = ""
		cfg.ComposioUserAPIKey = strings.TrimSpace(creds.UserAPIKey)
		cfg.ComposioOrgID = strings.TrimSpace(creds.OrgID)
		cfg.ComposioProjectID = strings.TrimSpace(creds.ProjectID)
	}
	return config.Save(cfg)
}
