import type { Config } from './config.js'
import { logger } from './logger.js'

/**
 * Отправка сообщений напрямую через Telegram Bot API (без библиотек).
 * send() — алерт администратору, sendPhoto() — карточка пользователю.
 */
export class TelegramNotifier {
	constructor(private readonly config: Config) {}

	get isConfigured(): boolean {
		return Boolean(this.config.telegramBotToken && this.config.telegramChatId)
	}

	async send(text: string): Promise<void> {
		if (!this.isConfigured) {
			logger.warn('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — алерт только в лог', { text })
			return
		}

		const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: this.config.telegramChatId,
					text,
					parse_mode: 'HTML',
					disable_web_page_preview: true,
				}),
			})

			if (!res.ok) {
				const body = await res.text()
				logger.error('Telegram API вернул ошибку при отправке алерта', {
					status: res.status,
					body: body.slice(0, 300),
				})
			}
		} catch (error) {
			logger.error('Не удалось отправить алерт в Telegram', { error: String(error) })
		}
	}

	/**
	 * Картинка с подписью и необязательной кнопкой-ссылкой.
	 * Возвращает текст ошибки или null, если доставлено (пользователь мог
	 * заблокировать бота — это не должно ломать прогон).
	 */
	async sendPhoto(
		chatId: number | string,
		png: Buffer,
		caption: string,
		button?: { text: string; url: string },
	): Promise<string | null> {
		if (!this.config.telegramBotToken) return 'TELEGRAM_BOT_TOKEN не задан'

		const form = new FormData()
		form.append('chat_id', String(chatId))
		form.append('caption', caption)
		form.append('parse_mode', 'HTML')
		form.append('photo', new Blob([png], { type: 'image/png' }), 'traffic.png')
		if (button) {
			form.append('reply_markup', JSON.stringify({ inline_keyboard: [[button]] }))
		}

		try {
			const res = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendPhoto`, {
				method: 'POST',
				body: form,
			})
			if (res.ok) return null
			const body = await res.text()
			return `Telegram ${res.status}: ${body.slice(0, 200)}`
		} catch (error) {
			return String(error)
		}
	}
}
