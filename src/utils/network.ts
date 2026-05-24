import dns from 'node:dns'
import https from 'node:https'

// Force IPv4 for all DNS lookups — prevents OKX IP-whitelist rejections on dual-stack hosts.
dns.setDefaultResultOrder('ipv4first')

// Shared HTTPS agent bound to IPv4; pass via ExchangeConfig.options.agent to REST adapters.
export const httpsAgentV4 = new https.Agent({ family: 4, keepAlive: true })
