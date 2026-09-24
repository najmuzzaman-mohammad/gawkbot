package action

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/nex-crm/wuphf/internal/config"
)

const defaultComposioBaseURL = "https://backend.composio.dev/api/v3"

// composioMaxResponseBytes is the security bound on a single Composio HTTP read.
// It is a modest cap, not a content shaper: a read that exceeds it returns a
// clean error (the caller narrows the query), never silently-truncated bytes.
const composioMaxResponseBytes = 4 << 20 // 4 MiB

type ComposioREST struct {
	// APIKey is a project-scoped `ak_` key (sent as x-api-key). When set it
	// takes precedence over the user-key fields below.
	APIKey string
	// UserAPIKey/OrgID/ProjectID are the user-key auth mode: the `uak_` session
	// key plus org (required) and project (optional) ids, sent as
	// x-user-api-key / x-org-id / x-project-id. This is a CLI SESSION
	// credential: Composio revokes it on re-login and on session expiry, which
	// is why every request path can re-mint (see composio_auth.go).
	UserAPIKey string
	OrgID      string
	ProjectID  string
	UserID     string
	BaseURL    string
	Client     *http.Client
	// Reauth overrides the process-wide re-mint provider for this client.
	// Normally nil — SetComposioReauth registers one for every caller at once.
	// Tests set it directly.
	Reauth ComposioReauthFunc
	// refreshed holds credentials adopted after a successful re-mint, so a
	// long-lived client stops replaying a credential Composio has revoked.
	refreshed atomic.Pointer[ComposioCredentials]
}

type ComposioAPIError struct {
	Method     string
	Path       string
	StatusCode int
	Status     string
	RequestID  string
	RetryAfter string
	// Code and Slug are Composio's machine-readable classification, parsed
	// from the response body. Its human `message` is deliberately not kept:
	// the project-key branch echoes a masked key into it.
	Code int
	Slug string
	// CredentialKind names which auth mode Composio rejected, when it rejected
	// the credential rather than the request.
	CredentialKind ComposioCredentialKind
	// credentialRevoked marks a rejection of the credential itself, so Unwrap
	// can expose ErrComposioCredentialRevoked to errors.Is.
	credentialRevoked bool
}

func (e *ComposioAPIError) Error() string {
	parts := []string{"composio API failed", strings.TrimSpace(e.Method), strings.TrimSpace(e.Path), strings.TrimSpace(e.Status)}
	if slug := strings.TrimSpace(e.Slug); slug != "" {
		parts = append(parts, "slug="+slug)
	}
	if requestID := strings.TrimSpace(e.RequestID); requestID != "" {
		parts = append(parts, "request_id="+requestID)
	}
	if retryAfter := strings.TrimSpace(e.RetryAfter); retryAfter != "" {
		parts = append(parts, "retry_after="+retryAfter)
	}
	return strings.Join(compactStrings(parts), " ")
}

// CredentialRevoked reports that Composio rejected the stored credential itself.
func (e *ComposioAPIError) CredentialRevoked() bool { return e != nil && e.credentialRevoked }

// Unwrap exposes ErrComposioCredentialRevoked to errors.Is so every caller —
// including ones several wraps away — can branch on the cause instead of on the
// message or the status code.
func (e *ComposioAPIError) Unwrap() error {
	if e != nil && e.credentialRevoked {
		return ErrComposioCredentialRevoked
	}
	return nil
}

func NewComposioFromEnv() *ComposioREST {
	baseURL := strings.TrimSpace(strings.TrimRight(configResolveComposioBaseURL(), "/"))
	if baseURL == "" {
		baseURL = defaultComposioBaseURL
	}
	return &ComposioREST{
		APIKey:     strings.TrimSpace(config.ResolveComposioAPIKey()),
		UserAPIKey: strings.TrimSpace(config.ResolveComposioUserAPIKey()),
		OrgID:      strings.TrimSpace(config.ResolveComposioOrgID()),
		ProjectID:  strings.TrimSpace(config.ResolveComposioProjectID()),
		UserID:     strings.TrimSpace(config.ResolveComposioUserID()),
		BaseURL:    baseURL,
		Client:     &http.Client{Timeout: 30 * time.Second},
	}
}

// hasAuth reports whether the client carries usable Composio credentials:
// either a project `ak_` key, or the user-key pair (`uak_` + org id).
func (c *ComposioREST) hasAuth() bool {
	return !c.creds().empty()
}

// applyAuthHeaders sets the auth headers for the active mode: x-api-key for a
// project key, else x-user-api-key + x-org-id (+ x-project-id when known).
//
// x-api-key (project ak_ key) is Composio's DOCUMENTED public-API auth and is
// what the sign-in flow mints and stores: `composio dev init` resolves or
// creates a project key (POST /api/v3/org/project/{id}/api_keys/create) and
// writes it to .env.local — verified in composio CLI 0.2.31.
//
// The x-user-api-key trio is the auth the official `composio` CLI uses
// internally. It works against /api/v3 and /api/v3.1, but it is a SESSION
// credential: Composio revokes it on re-login and on expiry, answering
// 401 UserApiKey_Unauthorized thereafter. It is therefore only a fallback for
// when the project-key mint fails, and every request path can detect the
// rejection and re-mint (composio_auth.go).
func (c *ComposioREST) applyAuthHeaders(h http.Header) {
	creds := c.creds()
	if creds.APIKey != "" {
		h.Set("x-api-key", creds.APIKey)
		return
	}
	h.Set("x-user-api-key", creds.UserAPIKey)
	h.Set("x-org-id", creds.OrgID)
	if creds.ProjectID != "" {
		h.Set("x-project-id", creds.ProjectID)
	}
}

func (c *ComposioREST) Name() string { return "composio" }

// Configured reports whether this client can talk to Composio: usable
// credentials plus a user identity to namespace connected accounts under.
// Composio authenticates directly against its own REST API, so nothing outside
// those two facts may gate it.
func (c *ComposioREST) Configured() bool {
	return c.hasAuth() && strings.TrimSpace(c.UserID) != ""
}

func (c *ComposioREST) Supports(cap Capability) bool {
	switch cap {
	case CapabilityGuide,
		CapabilityConnections,
		CapabilityActionSearch,
		CapabilityActionKnowledge,
		CapabilityActionExecute,
		CapabilityWorkflowCreate,
		CapabilityWorkflowExecute,
		CapabilityWorkflowRuns,
		CapabilityRelayList,
		CapabilityRelayEventTypes,
		CapabilityRelayCreate,
		CapabilityRelayActivate:
		return true
	default:
		return false
	}
}

func (c *ComposioREST) ListIntegrationCatalog(ctx context.Context, opts IntegrationCatalogOptions) (IntegrationCatalogResult, error) {
	connections, err := c.ListConnections(ctx, ListConnectionsOptions{Limit: 500})
	if err != nil {
		return IntegrationCatalogResult{}, err
	}
	byPlatform := make(map[string][]Connection)
	for _, conn := range connections.Connections {
		platform := normalizeComposioPlatform(conn.Platform)
		byPlatform[platform] = append(byPlatform[platform], conn)
	}

	query := url.Values{}
	if search := strings.TrimSpace(opts.Search); search != "" {
		query.Set("search", search)
		query.Set("query", search)
	}
	if opts.Limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", opts.Limit))
	} else {
		query.Set("limit", "50")
	}
	if cursor := strings.TrimSpace(opts.Cursor); cursor != "" {
		query.Set("cursor", cursor)
	}
	raw, err := c.get(ctx, "/toolkits", query)
	if err != nil {
		return IntegrationCatalogResult{}, err
	}
	var result struct {
		Items []struct {
			Slug        string            `json:"slug"`
			Name        string            `json:"name"`
			Description string            `json:"description"`
			Logo        string            `json:"logo"`
			LogoURL     string            `json:"logo_url"`
			Categories  []json.RawMessage `json:"categories"`
			Category    string            `json:"category"`
			Meta        struct {
				Description string            `json:"description"`
				Logo        string            `json:"logo"`
				Categories  []json.RawMessage `json:"categories"`
			} `json:"meta"`
		} `json:"items"`
		NextCursor string `json:"next_cursor"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return IntegrationCatalogResult{}, fmt.Errorf("parse composio toolkits: %w", err)
	}

	connectedFilter := strings.ToLower(strings.TrimSpace(opts.Connected))
	out := IntegrationCatalogResult{NextCursor: strings.TrimSpace(result.NextCursor)}
	for _, item := range result.Items {
		platform := normalizeComposioPlatform(item.Slug)
		if platform == "" {
			continue
		}
		// Hide Composio's own meta-toolkits (e.g. "Composio", "Composio
		// Search"): the product is white-labeled as "Integrations".
		if strings.HasPrefix(strings.ToLower(platform), "composio") ||
			strings.HasPrefix(strings.ToLower(strings.TrimSpace(item.Name)), "composio") {
			continue
		}
		conns := byPlatform[platform]
		hasConnection := len(conns) > 0
		switch connectedFilter {
		case "true", "1", "connected":
			if !hasConnection {
				continue
			}
		case "false", "0", "available":
			if hasConnection {
				continue
			}
		}
		state := "available"
		connectionKey := ""
		connectionName := ""
		if hasConnection {
			state = connectionState(conns[0].State)
			connectionKey = strings.TrimSpace(conns[0].Key)
			connectionName = strings.TrimSpace(conns[0].Name)
		}
		category := firstNonEmpty(
			item.Category,
			firstComposioCategory(item.Categories),
			firstComposioCategory(item.Meta.Categories),
		)
		logoURL := firstNonEmpty(item.LogoURL, item.Logo, item.Meta.Logo)
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = DisplayPlatformName(platform)
		}
		out.Items = append(out.Items, IntegrationCatalogItem{
			Provider:       c.Name(),
			Platform:       platform,
			Name:           name,
			Description:    firstNonEmpty(item.Description, item.Meta.Description),
			Category:       category,
			LogoURL:        logoURL,
			State:          state,
			ConnectionKey:  connectionKey,
			ConnectionName: connectionName,
			CanConnect:     true,
			CanDisconnect:  hasConnection,
			Connections:    append([]Connection(nil), conns...),
		})
	}
	return out, nil
}

func (c *ComposioREST) StartIntegrationConnection(ctx context.Context, req IntegrationConnectRequest) (IntegrationConnectResult, error) {
	platform := normalizeComposioPlatform(req.Platform)
	if platform == "" {
		return IntegrationConnectResult{}, fmt.Errorf("platform is required")
	}
	// Toolkits Composio cannot host an OAuth app for (API-key / token auth, e.g.
	// Instantly) cannot use the managed-auth flow — that path returns a bare
	// "400 POST /auth_configs". Detect them up front and ask the UI to collect
	// the user's credentials instead of failing opaquely.
	if info := c.toolkitAuthInfo(ctx, platform); !info.Managed {
		return IntegrationConnectResult{
			Provider:       c.Name(),
			Platform:       platform,
			Status:         "needs_fields",
			AuthMode:       strings.ToLower(info.Mode),
			RequiredFields: info.Fields,
			Instructions:   "Enter your " + DisplayPlatformName(platform) + " credentials to connect.",
		}, nil
	}
	authConfigID, err := c.composioManagedAuthConfigID(ctx, platform)
	if err != nil {
		return IntegrationConnectResult{}, err
	}
	body := map[string]any{
		"auth_config_id": authConfigID,
		"user_id":        strings.TrimSpace(c.UserID),
	}
	// Use link() (hosted auth), NOT initiate(): Composio is deprecating
	// initiate() for Composio-managed OAuth (new orgs 2026-05-08, all orgs
	// 2026-07-03). link() is the recommended, unaffected path and allows
	// multiple accounts per toolkit. Do not switch this back to
	// /connected_accounts initiate.
	raw, err := c.post(ctx, "/connected_accounts/link", body)
	if err != nil {
		return IntegrationConnectResult{}, err
	}
	var result struct {
		ID                  string `json:"id"`
		RedirectURL         string `json:"redirect_url"`
		AuthURL             string `json:"auth_url"`
		URL                 string `json:"url"`
		Status              string `json:"status"`
		ExpiresAt           string `json:"expires_at"`
		ConnectedAccountID  string `json:"connected_account_id"`
		ConnectionRequestID string `json:"connection_request_id"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return IntegrationConnectResult{}, fmt.Errorf("parse composio connect link: %w", err)
	}
	authURL := firstNonEmpty(result.RedirectURL, result.AuthURL, result.URL)
	connectID := strings.TrimSpace(result.ConnectedAccountID)
	status := strings.ToLower(strings.TrimSpace(result.Status))
	if status == "" {
		status = "pending"
	}
	if authURL == "" && connectID == "" {
		return IntegrationConnectResult{}, fmt.Errorf("composio connect link response did not include auth_url or connection id")
	}
	return IntegrationConnectResult{
		Provider:  c.Name(),
		Platform:  platform,
		Status:    status,
		AuthURL:   authURL,
		ConnectID: connectID,
		ExpiresAt: strings.TrimSpace(result.ExpiresAt),
	}, nil
}

func (c *ComposioREST) GetIntegrationConnectionStatus(ctx context.Context, req IntegrationStatusRequest) (IntegrationConnectResult, error) {
	platform := normalizeComposioPlatform(req.Platform)
	connectID := strings.TrimSpace(req.ConnectID)
	if connectID != "" {
		account, err := c.connectedAccount(ctx, connectID)
		if err != nil {
			return IntegrationConnectResult{}, err
		}
		if platform == "" {
			platform = normalizeComposioPlatform(firstNonEmpty(account.ToolkitSlug, account.Toolkit.Slug))
		}
		return IntegrationConnectResult{
			Provider:      c.Name(),
			Platform:      platform,
			Status:        connectionState(account.Status),
			ConnectID:     connectID,
			ConnectionKey: strings.TrimSpace(account.ID),
		}, nil
	}
	if platform == "" {
		return IntegrationConnectResult{}, fmt.Errorf("connect_id or platform is required")
	}
	connections, err := c.ListConnections(ctx, ListConnectionsOptions{Search: platform, Limit: 100})
	if err != nil {
		return IntegrationConnectResult{}, err
	}
	for _, conn := range connections.Connections {
		if normalizeComposioPlatform(conn.Platform) == platform {
			return IntegrationConnectResult{
				Provider:      c.Name(),
				Platform:      platform,
				Status:        connectionState(conn.State),
				ConnectID:     conn.Key,
				ConnectionKey: conn.Key,
			}, nil
		}
	}
	return IntegrationConnectResult{Provider: c.Name(), Platform: platform, Status: "pending"}, nil
}

func (c *ComposioREST) DisconnectIntegration(ctx context.Context, req IntegrationDisconnectRequest) (IntegrationDisconnectResult, error) {
	connectionKey := strings.TrimSpace(req.ConnectionKey)
	if connectionKey == "" {
		return IntegrationDisconnectResult{}, fmt.Errorf("connection_key is required")
	}
	platform := normalizeComposioPlatform(req.Platform)
	if _, err := c.delete(ctx, "/connected_accounts/"+url.PathEscape(connectionKey)); err != nil {
		return IntegrationDisconnectResult{}, err
	}
	return IntegrationDisconnectResult{
		OK:            true,
		Provider:      c.Name(),
		Platform:      platform,
		ConnectionKey: connectionKey,
		Status:        "disconnected",
	}, nil
}

func (c *ComposioREST) Guide(_ context.Context, topic string) (GuideResult, error) {
	if strings.TrimSpace(topic) == "" {
		topic = "all"
	}
	raw, _ := json.Marshal(map[string]any{
		"provider": "composio",
		"topic":    topic,
		"notes": []string{
			"Use search -> knowledge -> dry-run -> execute for external actions.",
			"Use connected account IDs returned by team_action_connections as the connection_key. If a workflow omits connection_key and there is exactly one active connection for that platform, WUPHF auto-resolves it.",
			"Trigger registration is supported through the existing relay compatibility tools with one event filter per trigger.",
			"Workflow creation and execution are WUPHF-native: save a workflow definition in WUPHF, then WUPHF executes external steps through Composio.",
			`Supported WUPHF workflow step types: "action", "template", and "browser".`,
			"Every workflow step also exposes a generic .result value: action=result response object, template=result text, browser=result outcome text.",
			"Use a template step to compress large action output into concise text before handing it to another action.",
			"Keep workflows compact. For digest/report flows, default to about 10 recent items unless the human explicitly asks for more.",
			"Do not dump raw JSON from .response into an action parameter when a compact .result summary will do.",
		},
		"workflow_examples": []map[string]any{{
			"version": composioWorkflowVersion,
			"inputs": map[string]any{
				"connection_key":  "ca_...",
				"recipient_email": config.ResolveComposioUserID(),
				"subject":         "Daily digest",
			},
			"steps": []map[string]any{
				{
					"id":             "fetch_emails",
					"type":           "action",
					"platform":       "gmail",
					"action_id":      "GMAIL_FETCH_EMAILS",
					"connection_key": "{{ .inputs.connection_key }}",
					"data": map[string]any{
						"query":       "newer_than:1d",
						"max_results": 10,
					},
				},
				{
					"id":       "email_summary",
					"type":     "template",
					"template": "Email highlights from the last 24 hours:\n{{- range $m := .steps.fetch_emails.result.data.messages }}\n- {{ $m.sender }} | {{ $m.subject }} | {{ $m.preview.body }}\n{{- end }}",
				},
				{
					"id":             "send_email",
					"type":           "action",
					"platform":       "gmail",
					"action_id":      "GMAIL_SEND_EMAIL",
					"connection_key": "{{ .inputs.connection_key }}",
					"data": map[string]any{
						"recipient_email": "{{ .inputs.recipient_email }}",
						"subject":         "{{ .inputs.subject }}",
						"body":            "{{ .steps.email_summary.result }}",
					},
				},
			},
		}},
	})
	return GuideResult{Topic: topic, Raw: raw}, nil
}

func (c *ComposioREST) ListConnections(ctx context.Context, opts ListConnectionsOptions) (ConnectionsResult, error) {
	query := url.Values{}
	if opts.Limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", opts.Limit))
	}
	raw, err := c.get(ctx, "/connected_accounts", query)
	if err != nil {
		return ConnectionsResult{}, err
	}
	var result struct {
		Items []struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Toolkit struct {
				Slug string `json:"slug"`
				Name string `json:"name"`
			} `json:"toolkit"`
			Connection struct {
				Name string `json:"name"`
			} `json:"connection"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ConnectionsResult{}, fmt.Errorf("parse composio connections: %w", err)
	}
	out := ConnectionsResult{Total: len(result.Items), Showing: len(result.Items), Search: opts.Search}
	search := strings.ToLower(strings.TrimSpace(opts.Search))
	for _, item := range result.Items {
		platform := strings.TrimSpace(item.Toolkit.Slug)
		name := strings.TrimSpace(item.Connection.Name)
		if name == "" {
			name = strings.TrimSpace(item.ID)
		}
		if search != "" && !strings.Contains(strings.ToLower(platform), search) && !strings.Contains(strings.ToLower(name), search) {
			continue
		}
		out.Connections = append(out.Connections, Connection{
			Platform: platform,
			State:    strings.ToLower(strings.TrimSpace(item.Status)),
			Key:      strings.TrimSpace(item.ID),
			Name:     name,
		})
	}
	out.Total = len(out.Connections)
	out.Showing = len(out.Connections)
	return out, nil
}

func (c *ComposioREST) SearchActions(ctx context.Context, platform, queryText, mode string) (ActionSearchResult, error) {
	query := url.Values{}
	if p := normalizeComposioPlatform(platform); p != "" {
		query.Set("toolkit_slug", p)
	}
	if q := strings.TrimSpace(queryText); q != "" {
		query.Set("query", q)
	}
	query.Set("limit", "10")
	raw, err := c.get(ctx, "/tools", query)
	if err != nil {
		return ActionSearchResult{}, err
	}
	var result struct {
		Items []struct {
			Slug        string `json:"slug"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Toolkit     struct {
				Slug string `json:"slug"`
			} `json:"toolkit"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ActionSearchResult{}, fmt.Errorf("parse composio tools: %w", err)
	}
	out := ActionSearchResult{Platform: platform, Query: queryText, Mode: mode}
	for _, item := range result.Items {
		title := strings.TrimSpace(item.Name)
		if title == "" {
			title = strings.TrimSpace(item.Description)
		}
		out.Actions = append(out.Actions, Action{
			ActionID: strings.TrimSpace(item.Slug),
			Title:    title,
			Path:     strings.TrimSpace(item.Toolkit.Slug),
		})
	}
	return out, nil
}

func (c *ComposioREST) ActionKnowledge(ctx context.Context, _ string, actionID string) (KnowledgeResult, error) {
	raw, err := c.get(ctx, "/tools/"+url.PathEscape(strings.TrimSpace(actionID)), url.Values{"toolkit_versions": []string{"latest"}})
	if err != nil {
		return KnowledgeResult{}, err
	}
	var result struct {
		Slug             string          `json:"slug"`
		Name             string          `json:"name"`
		Description      string          `json:"description"`
		InputParameters  json.RawMessage `json:"input_parameters"`
		OutputParameters json.RawMessage `json:"output_parameters"`
		Toolkit          struct {
			Slug string `json:"slug"`
		} `json:"toolkit"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return KnowledgeResult{}, fmt.Errorf("parse composio tool detail: %w", err)
	}
	knowledge, _ := json.MarshalIndent(map[string]any{
		"name":              result.Name,
		"description":       result.Description,
		"toolkit":           result.Toolkit.Slug,
		"input_parameters":  result.InputParameters,
		"output_parameters": result.OutputParameters,
	}, "", "  ")
	return KnowledgeResult{
		Platform:  strings.TrimSpace(result.Toolkit.Slug),
		ActionID:  strings.TrimSpace(result.Slug),
		Knowledge: string(knowledge),
	}, nil
}

func (c *ComposioREST) ExecuteAction(ctx context.Context, req ExecuteRequest) (ExecuteResult, error) {
	requestPayload := map[string]any{
		"user_id": c.UserID,
	}
	if key := strings.TrimSpace(req.ConnectionKey); key != "" {
		if meta, err := c.connectedAccount(ctx, key); err == nil {
			if userID := strings.TrimSpace(meta.UserID); userID != "" {
				requestPayload["user_id"] = userID
			}
		}
		requestPayload["connected_account_id"] = key
	}
	if len(req.Data) > 0 {
		requestPayload["arguments"] = req.Data
	}
	envelope := ExecuteEnvelope{
		Method: "POST",
		URL:    c.BaseURL + "/tools/execute/" + url.PathEscape(strings.TrimSpace(req.ActionID)),
		Data:   requestPayload,
	}
	if req.DryRun {
		return ExecuteResult{DryRun: true, Request: envelope}, nil
	}
	raw, err := c.post(ctx, "/tools/execute/"+url.PathEscape(strings.TrimSpace(req.ActionID)), requestPayload)
	if err != nil {
		return ExecuteResult{}, err
	}
	return ExecuteResult{
		DryRun:   false,
		Request:  envelope,
		Response: raw,
	}, nil
}

func (c *ComposioREST) ListRelays(ctx context.Context, opts ListRelaysOptions) (RelayListResult, error) {
	query := url.Values{}
	if opts.Limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", opts.Limit))
	}
	query.Set("show_disabled", "true")
	raw, err := c.get(ctx, "/trigger_instances/active", query)
	if err != nil {
		return RelayListResult{}, err
	}
	var result struct {
		Items []struct {
			ID                 string `json:"id"`
			TriggerName        string `json:"trigger_name"`
			ConnectedAccountID string `json:"connected_account_id"`
			UpdatedAt          string `json:"updated_at"`
			DisabledAt         string `json:"disabled_at"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return RelayListResult{}, fmt.Errorf("parse composio triggers: %w", err)
	}
	out := RelayListResult{Total: len(result.Items), Showing: len(result.Items)}
	for _, item := range result.Items {
		active := strings.TrimSpace(item.DisabledAt) == ""
		out.Endpoints = append(out.Endpoints, Relay{
			ID:           strings.TrimSpace(item.ID),
			Active:       active,
			Description:  strings.TrimSpace(item.TriggerName),
			EventFilters: composioCompactStrings([]string{strings.TrimSpace(item.TriggerName)}),
			CreatedAt:    strings.TrimSpace(item.UpdatedAt),
		})
	}
	return out, nil
}

func (c *ComposioREST) RelayEventTypes(ctx context.Context, platform string) (RelayEventTypesResult, error) {
	query := url.Values{}
	if p := normalizeComposioPlatform(platform); p != "" {
		query.Add("toolkit_slugs", p)
	}
	query.Set("limit", "100")
	raw, err := c.get(ctx, "/triggers_types", query)
	if err != nil {
		return RelayEventTypesResult{}, err
	}
	var result struct {
		Items []struct {
			Slug string `json:"slug"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return RelayEventTypesResult{}, fmt.Errorf("parse composio trigger types: %w", err)
	}
	out := RelayEventTypesResult{Platform: platform}
	for _, item := range result.Items {
		out.EventTypes = append(out.EventTypes, strings.TrimSpace(item.Slug))
	}
	return out, nil
}

func (c *ComposioREST) CreateRelay(ctx context.Context, req RelayCreateRequest) (RelayResult, error) {
	if len(req.EventFilters) != 1 {
		return RelayResult{}, fmt.Errorf("composio trigger registration currently requires exactly one event filter")
	}
	triggerSlug := strings.TrimSpace(req.EventFilters[0])
	raw, err := c.post(ctx, "/trigger_instances/"+url.PathEscape(triggerSlug)+"/upsert", map[string]any{
		"connected_account_id": strings.TrimSpace(req.ConnectionKey),
		"trigger_config":       map[string]any{},
	})
	if err != nil {
		return RelayResult{}, err
	}
	var result struct {
		TriggerID string `json:"trigger_id"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return RelayResult{}, fmt.Errorf("parse composio trigger create: %w", err)
	}
	return RelayResult{
		ID:           strings.TrimSpace(result.TriggerID),
		Active:       true,
		Description:  strings.TrimSpace(req.Description),
		EventFilters: composioCompactStrings(req.EventFilters),
	}, nil
}

func (c *ComposioREST) ActivateRelay(ctx context.Context, req RelayActivateRequest) (RelayResult, error) {
	_, err := c.patch(ctx, "/trigger_instances/manage/"+url.PathEscape(strings.TrimSpace(req.ID)), map[string]any{
		"status": "enable",
	})
	if err != nil {
		return RelayResult{}, err
	}
	return RelayResult{
		ID:     strings.TrimSpace(req.ID),
		Active: true,
	}, nil
}

func (c *ComposioREST) ListRelayEvents(context.Context, RelayEventsOptions) (RelayEventsResult, error) {
	return RelayEventsResult{}, fmt.Errorf("composio trigger event polling is not wired into WUPHF yet")
}

func (c *ComposioREST) GetRelayEvent(context.Context, string) (RelayEventDetail, error) {
	return RelayEventDetail{}, fmt.Errorf("composio trigger event fetch is not wired into WUPHF yet")
}

func (c *ComposioREST) get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	return c.do(ctx, http.MethodGet, path, query, nil)
}

func (c *ComposioREST) post(ctx context.Context, path string, body any) ([]byte, error) {
	return c.do(ctx, http.MethodPost, path, nil, body)
}

func (c *ComposioREST) patch(ctx context.Context, path string, body any) ([]byte, error) {
	return c.do(ctx, http.MethodPatch, path, nil, body)
}

func (c *ComposioREST) delete(ctx context.Context, path string) ([]byte, error) {
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}

// do issues the request and, when Composio rejects the STORED CREDENTIAL (not
// the request), attempts exactly one silent re-mint and exactly one retry
// before giving up. A user whose CLI session is still good never sees anything
// but their integration working; a user whose CLI session is gone too gets the
// typed ErrComposioCredentialRevoked cause, which the HTTP boundary turns into
// a human sentence plus a re-sign-in button.
//
// Loop safety: one re-mint and one retry per request, and the retry is skipped
// unless the provider actually handed back a DIFFERENT credential — replaying
// the same dead key would only burn a second round trip. Concurrency safety is
// the provider's job (it single-flights the CLI invocation).
func (c *ComposioREST) do(ctx context.Context, method, path string, query url.Values, body any) ([]byte, error) {
	if !c.Configured() {
		return nil, fmt.Errorf("composio is not configured; set COMPOSIO_API_KEY (or sign in with Composio) and a user identity")
	}
	var payload []byte
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = raw
	}
	raw, err := c.attempt(ctx, method, path, query, payload)
	var apiErr *ComposioAPIError
	if !errors.As(err, &apiErr) || !apiErr.CredentialRevoked() {
		return raw, err
	}
	reauth := c.reauth()
	if reauth == nil {
		return nil, err
	}
	next, reauthErr := reauth(ctx)
	if reauthErr != nil {
		// Recovery is impossible (no valid CLI session). Keep the typed cause
		// so the boundary can speak human; the re-mint failure itself is not
		// re-wrapped, because its text is diagnostic, not user-facing.
		return nil, err
	}
	if !c.adoptCredentials(next) {
		return nil, err
	}
	return c.attempt(ctx, method, path, query, payload)
}

// attempt performs a single Composio round trip. A non-2xx is returned as a
// *ComposioAPIError carrying Composio's machine-readable classification.
func (c *ComposioREST) attempt(ctx context.Context, method, path string, query url.Values, payload []byte) ([]byte, error) {
	u := strings.TrimRight(c.BaseURL, "/") + path
	if encoded := query.Encode(); encoded != "" {
		u += "?" + encoded
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return nil, err
	}
	c.applyAuthHeaders(req.Header)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// Cap the response read at a modest security bound. The old code read with a
	// LimitReader and silently kept the truncated prefix — a response larger than
	// the cap was cut mid-JSON, yielding invalid bytes that surfaced downstream as
	// an empty/failed result. Read one byte past the cap and treat any overflow as
	// a CLEAN ERROR instead of truncating to corrupt JSON, so every successful read
	// is valid-JSON-or-error. An app that needs less data should narrow its query
	// (e.g. request metadata + snippet, not full bodies); the platform does not
	// grow to accommodate an over-fetch.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, composioMaxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > composioMaxResponseBytes {
		return nil, fmt.Errorf("composio: %s %s response exceeded %d bytes; narrow the query", method, path, composioMaxResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		revoked, kind, code, slug, bodyRequestID := classifyComposioAuthFailure(resp.StatusCode, raw)
		return nil, &ComposioAPIError{
			Method:     method,
			Path:       path,
			StatusCode: resp.StatusCode,
			Status:     resp.Status,
			RequestID: firstNonEmpty(
				resp.Header.Get("x-request-id"),
				resp.Header.Get("request-id"),
				bodyRequestID,
			),
			RetryAfter:        resp.Header.Get("Retry-After"),
			Code:              code,
			Slug:              slug,
			CredentialKind:    kind,
			credentialRevoked: revoked,
		}
	}
	return raw, nil
}

type composioConnectedAccount struct {
	ID      string `json:"id"`
	UserID  string `json:"user_id"`
	Status  string `json:"status"`
	Toolkit struct {
		Slug string `json:"slug"`
	} `json:"toolkit"`
	ToolkitSlug string `json:"toolkit_slug"`
}

func (c *ComposioREST) connectedAccount(ctx context.Context, id string) (composioConnectedAccount, error) {
	raw, err := c.get(ctx, "/connected_accounts/"+url.PathEscape(strings.TrimSpace(id)), nil)
	if err != nil {
		return composioConnectedAccount{}, err
	}
	var result composioConnectedAccount
	if err := json.Unmarshal(raw, &result); err != nil {
		return composioConnectedAccount{}, fmt.Errorf("parse composio connected account: %w", err)
	}
	return result, nil
}

type composioAuthConfig struct {
	ID                 string `json:"id"`
	Status             string `json:"status"`
	IsComposioManaged  bool   `json:"is_composio_managed"`
	IsComposioProvided bool   `json:"is_composio_provided"`
	Toolkit            struct {
		Slug string `json:"slug"`
	} `json:"toolkit"`
	ToolkitSlug string `json:"toolkit_slug"`
}

func (c *ComposioREST) composioManagedAuthConfigID(ctx context.Context, platform string) (string, error) {
	configs, err := c.listAuthConfigs(ctx, platform)
	if err != nil {
		return "", err
	}
	for _, cfg := range configs {
		if !strings.EqualFold(normalizeComposioPlatform(firstNonEmpty(cfg.ToolkitSlug, cfg.Toolkit.Slug)), platform) {
			continue
		}
		if cfg.IsComposioManaged || cfg.IsComposioProvided || strings.EqualFold(strings.TrimSpace(cfg.Status), "active") {
			if id := strings.TrimSpace(cfg.ID); id != "" {
				return id, nil
			}
		}
	}
	return c.createComposioManagedAuthConfig(ctx, platform)
}

func (c *ComposioREST) listAuthConfigs(ctx context.Context, platform string) ([]composioAuthConfig, error) {
	query := url.Values{}
	query.Set("toolkit_slug", platform)
	query.Set("limit", "100")
	raw, err := c.get(ctx, "/auth_configs", query)
	if err != nil {
		return nil, err
	}
	var result struct {
		Items []composioAuthConfig `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, fmt.Errorf("parse composio auth configs: %w", err)
	}
	return result.Items, nil
}

func (c *ComposioREST) createComposioManagedAuthConfig(ctx context.Context, platform string) (string, error) {
	// v3 schema: the toolkit and auth config are nested objects. The older flat
	// shape (toolkit_slug/type/is_composio_managed) now 400s with
	// "payload.toolkit: Required".
	body := map[string]any{
		"toolkit": map[string]any{"slug": platform},
		"auth_config": map[string]any{
			"type": "use_composio_managed_auth",
			"name": "WUPHF " + DisplayPlatformName(platform),
		},
	}
	raw, err := c.post(ctx, "/auth_configs", body)
	if err != nil {
		return "", err
	}
	// v3 returns the created config nested under auth_config; older shapes put
	// the id at the top level or under item/data.
	var result struct {
		ID         string             `json:"id"`
		AuthConfig composioAuthConfig `json:"auth_config"`
		Item       composioAuthConfig `json:"item"`
		Data       composioAuthConfig `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("parse composio auth config create: %w", err)
	}
	if id := strings.TrimSpace(firstNonEmpty(result.ID, result.AuthConfig.ID, result.Item.ID, result.Data.ID)); id != "" {
		return id, nil
	}
	return "", fmt.Errorf("composio auth config response did not include id")
}

func normalizeComposioPlatform(platform string) string {
	p := strings.ToLower(strings.TrimSpace(platform))
	p = strings.ReplaceAll(p, " ", "")
	p = strings.ReplaceAll(p, "_", "")
	switch p {
	case "googlecalendar":
		return "googlecalendar"
	case "hubspot":
		return "hubspot"
	case "salesforce":
		return "salesforce"
	case "gmail":
		return "gmail"
	case "slack":
		return "slack"
	default:
		return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(platform)), "_", "")
	}
}

func connectionState(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "active", "connected", "enabled":
		return "connected"
	case "initiated", "pending", "in_progress":
		return "pending"
	case "failed", "error":
		return "failed"
	case "disabled", "inactive", "disconnected":
		return "disconnected"
	default:
		if strings.TrimSpace(state) == "" {
			return "available"
		}
		return strings.ToLower(strings.TrimSpace(state))
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstComposioCategory(rawCategories []json.RawMessage) string {
	for _, raw := range rawCategories {
		var label string
		if err := json.Unmarshal(raw, &label); err == nil {
			if trimmed := strings.TrimSpace(label); trimmed != "" {
				return trimmed
			}
			continue
		}
		var category struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &category); err != nil {
			continue
		}
		if value := firstNonEmpty(category.Name, category.ID); value != "" {
			return value
		}
	}
	return ""
}

func composioCompactStrings(items []string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func configResolveComposioBaseURL() string {
	if v := strings.TrimSpace(strings.TrimRight(os.Getenv("WUPHF_COMPOSIO_BASE_URL"), "/")); v != "" {
		return v
	}
	if v := strings.TrimSpace(strings.TrimRight(os.Getenv("COMPOSIO_BASE_URL"), "/")); v != "" {
		return v
	}
	return defaultComposioBaseURL
}

func compactStrings(ss []string) []string {
	var out []string
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

func fallbackString(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
