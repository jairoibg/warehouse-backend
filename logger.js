export const aiLogger = {
  info: (msg, data) => console.log(`🔵 [INFO] ${msg}`, data || ''),
  success: (msg, data) => console.log(`✅ [SUCCESS] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`⚠️ [WARN] ${msg}`, data || ''),
  error: (msg, data) => console.error(`❌ [ERROR] ${msg}`, data || '')
};