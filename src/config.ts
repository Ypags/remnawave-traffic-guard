import { loadEnvFile } from './env.js'

loadEnvFile()

const requireEnv = (name: string): string => {
	const value = process.env[name]
	if (!value) {
		throw new Error(`Не задана обязательная переменная окружения: ${name}`)
	}
	return value
}

const optionalEnv = (name: string, fallback: string): string => process.env[name] ?? fallback

const envNumber = (name: string, fallback: number): number => {
	const raw = process.env[name]
	if (raw === undefined || raw === '') return fallback
	const parsed = Number(raw)
	if (!Number.isFinite(parsed)) {
		throw new Error(`Переменная окружения ${name} должна быть числом, получено: ${raw}`)
	}
	return parsed
}

export interface Config {
	/** Базовый URL панели Remnawave, например https://panel.example.com */
	remnawaveUrl: string
	/** API-токен (Settings → API Tokens в панели, НЕ Admin JWT). */
	remnawaveApiToken: string
	/** Опциональные заголовки Cloudflare Zero Trust Service Token. */
	cfClientId?: string
	cfClientSecret?: string
	/** Таймаут одного HTTP-запроса к панели, мс. */
	requestTimeoutMs: number

	/** Порог трафика за окно, в байтах (считается из TRAFFIC_LIMIT_GB). */
	trafficLimitBytes: number
	/** Размер скользящего окна в миллисекундах (считается из WINDOW_MINUTES). */
	windowMs: number
	/** Период опроса панели, мс (считается из POLL_INTERVAL_SECONDS). */
	pollIntervalMs: number
	/** Сколько пользователей запрашивать за одну страницу (max 1000 у Remnawave). */
	pageSize: number

	/** Сколько предупреждений до блокировки (следующее превышение — блок). */
	warningsBeforeBlock: number
	/** Через сколько после первого предупреждения счётчик обнуляется, мс. */
	strikeResetMs: number
	/** Дней от первого предупреждения до обнуления (для текста сообщений). */
	strikeResetDays: number
	/** Ссылка на поддержку для кнопки в сообщении о блокировке. */
	supportUrl: string

	/** Предохранитель: абсолютное количество кандидатов на отключение за проход. */
	circuitBreakerMaxUsers: number
	/** Предохранитель: доля (%) кандидатов от числа просканированных активных пользователей. */
	circuitBreakerMaxPercent: number

	/** Токен основного бота: им шлём карточки пользователям и алерты админу. */
	telegramBotToken?: string
	/** chat_id администратора/группы, куда слать алерты. */
	telegramChatId?: string

	/** Куда сохранять историю окна (переживает рестарт). */
	stateFilePath: string
	/** Куда писать аудит-лог действий (JSON Lines). */
	actionsLogPath: string
}

export const loadConfig = (): Config => {
	const trafficLimitGb = envNumber('TRAFFIC_LIMIT_GB', 50)
	const strikeResetDays = envNumber('STRIKE_RESET_DAYS', 30)
	const windowMinutes = envNumber('WINDOW_MINUTES', 60)
	const pollIntervalSeconds = envNumber('POLL_INTERVAL_SECONDS', 300)

	return {
		remnawaveUrl: requireEnv('REMNAWAVE_URL').replace(/\/+$/, ''),
		remnawaveApiToken: requireEnv('REMNAWAVE_API_TOKEN'),
		cfClientId: process.env.CF_CLIENT_ID || undefined,
		cfClientSecret: process.env.CF_CLIENT_SECRET || undefined,
		requestTimeoutMs: envNumber('REQUEST_TIMEOUT_MS', 15_000),

		trafficLimitBytes: trafficLimitGb * 1024 * 1024 * 1024,
		windowMs: windowMinutes * 60_000,
		pollIntervalMs: pollIntervalSeconds * 1_000,
		pageSize: envNumber('PAGE_SIZE', 1000),

		warningsBeforeBlock: envNumber('WARNINGS_BEFORE_BLOCK', 3),
		strikeResetMs: strikeResetDays * 24 * 60 * 60 * 1000,
		strikeResetDays,
		supportUrl: optionalEnv('SUPPORT_URL', 'https://t.me/GraniVPNSupport'),

		circuitBreakerMaxUsers: envNumber('CIRCUIT_BREAKER_MAX_USERS', 5),
		circuitBreakerMaxPercent: envNumber('CIRCUIT_BREAKER_MAX_PERCENT', 10),

		telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
		telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,

		stateFilePath: optionalEnv('STATE_FILE_PATH', './data/state.json'),
		actionsLogPath: optionalEnv('ACTIONS_LOG_PATH', './data/actions.jsonl'),
	}
}
