// These values are public client configuration, not service-role credentials.
// Environment variables override them for forks or self-hosted deployments.
export const NEXARA_APP_URL = process.env.NEXARA_APP_URL || "https://nexara-ai-chat.vercel.app";
export const SUPABASE_URL = process.env.NEXARA_SUPABASE_URL || "https://rdxbecbomrtfmtoespow.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = process.env.NEXARA_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_tuhwNQ2vLFRwWWMQ3AzvWA_KXFsDhnZ";
export const DEFAULT_MODEL = "minimax/minimax-m2.5";
