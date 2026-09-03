package provider

// Hermes Bot exposes an OpenAI-compatible API server on :8642 when its
// gateway api_server platform is enabled. WUPHF uses that supported HTTP
// surface rather than OpenClaw's gateway WebSocket protocol, which Hermes does
// not expose.
const (
	defaultHermesBotBaseURL = "http://127.0.0.1:8642/v1"
	defaultHermesBotModel   = "hermes-agent"
)

func init() {
	Register(&Entry{
		Kind:     KindHermesBot,
		StreamFn: NewOpenAICompatStreamFn(KindHermesBot, defaultHermesBotBaseURL, defaultHermesBotModel),
		Capabilities: Capabilities{
			PaneEligible:    false,
			SupportsOneShot: false,
			GatewayOnly:     true,
		},
	})
}
