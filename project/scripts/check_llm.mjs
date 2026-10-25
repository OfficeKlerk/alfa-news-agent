// Configuration check only; makes no network requests and never prints the API key.
import { loadSettings } from '../dist/config.js';
try {
  const s = loadSettings();
  const url = new URL(s.baseUrl);
  if (!s.apiKey.trim()) throw new Error('Укажите LLM_API_KEY в личном .env. Не добавляйте ключ в Git.');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Нужен HTTPS LLM_BASE_URL без пароля, параметров и фрагмента.');
  if (s.maxCalls < 1) throw new Error('MAX_DAILY_LLM_CALLS должен быть больше нуля.');
  console.log(`Конфигурация LLM: host=${url.host}, model=${s.model}, timeout=${s.timeout / 1000}s, maxCalls=${s.maxCalls}. Доступ к провайдеру ещё не проверен.`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
