import { mkdirSync, writeFileSync } from 'node:fs'
import { renderCard, type CardLevel } from '../card.js'
import { loadConfig } from '../config.js'
import { buildUserCaption } from '../messages.js'
import { TelegramNotifier } from '../telegramNotifier.js'

/**
 * Пример всех карточек на выдуманных данных:
 *   npm run preview              — сохранить PNG в ./preview
 *   npm run preview -- --send    — ещё и отправить в TELEGRAM_CHAT_ID (админу)
 */
const GB = 1024 * 1024 * 1024

const main = async (): Promise<void> => {
	const send = process.argv.includes('--send')
	const config = send ? loadConfig() : undefined
	const notifier = config ? new TelegramNotifier(config) : undefined
	const limitBytes = 50 * GB
	const totalWarnings = 3

	const samples: { level: CardLevel; step: number; used: number; minutes: number; server: string; devices: string }[] = [
		{ level: 'warning', step: 1, used: 57.3, minutes: 60, server: 'Германия', devices: 'iPhone 15, Windows' },
		{ level: 'warning', step: 2, used: 54.6, minutes: 60, server: 'Германия', devices: 'iPhone 15, Windows' },
		{ level: 'last-warning', step: 3, used: 63.8, minutes: 60, server: 'Нидерланды', devices: 'iPhone 15, Android, Windows' },
		{ level: 'blocked', step: 4, used: 71.2, minutes: 65, server: 'Финляндия', devices: 'iPhone 15, Android, Windows' },
	]

	mkdirSync('preview', { recursive: true })
	for (const s of samples) {
		const png = renderCard({
			level: s.level,
			step: s.step,
			totalWarnings,
			usedBytes: s.used * GB,
			limitBytes,
			windowMinutes: s.minutes,
			server: s.server,
			devices: s.devices,
			at: new Date(),
		})
		writeFileSync(`preview/${s.step}-${s.level}.png`, png)

		if (notifier && config?.telegramChatId) {
			const caption = buildUserCaption({
				level: s.level,
				step: s.step,
				totalWarnings,
				usedBytes: s.used * GB,
				limitBytes,
				windowMinutes: s.minutes,
				strikeResetDays: config.strikeResetDays,
				resetAt: new Date(Date.now() + config.strikeResetMs),
			})
			const button = s.level === 'blocked' ? { text: 'Написать в поддержку', url: config.supportUrl } : undefined
			const error = await notifier.sendPhoto(config.telegramChatId, png, caption, button)
			console.log(s.level, error ?? 'отправлено')
		}
	}
	console.log('Готово: preview/')
}

void main()
