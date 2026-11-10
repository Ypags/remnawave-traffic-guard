import { appendActionLog } from './actionsLog.js'
import type { Config } from './config.js'
import { renderCard, type CardLevel } from './card.js'
import { logger } from './logger.js'
import { buildUserCaption } from './messages.js'
import { RemnawaveClient, type RemnawaveHwidDevice, type RemnawaveUser } from './remnawaveClient.js'
import { StateStore } from './stateStore.js'
import { TelegramNotifier } from './telegramNotifier.js'

const MAX_WINDOW_STRETCH = 1.25 // окно 60 мин можно растянуть максимум до 75 мин
const STALE_USER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // не видели в выгрузке 7 дней — забываем историю

const formatGb = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const COUNTRY_NAMES: Record<string, string> = {
	DE: 'Германия',
	NL: 'Нидерланды',
	FI: 'Финляндия',
	PL: 'Польша',
	GB: 'Великобритания',
	UK: 'Великобритания',
	FR: 'Франция',
	SE: 'Швеция',
	US: 'США',
	TR: 'Турция',
	KZ: 'Казахстан',
	LV: 'Латвия',
	EE: 'Эстония',
	LT: 'Литва',
	AT: 'Австрия',
	CH: 'Швейцария',
	RU: 'Россия',
}

/** Понятное название устройства: «iPhone 15», «Android», «Windows». */
const deviceLabel = (d: RemnawaveHwidDevice): string | null => {
	const model = d.deviceModel ?? ''
	const platform = (d.platform ?? '').toLowerCase()
	const ua = (d.userAgent ?? '').toLowerCase()
	if (/^(iphone|ipad)/i.test(model)) return model
	if (platform.startsWith('ios') || ua.includes('ios')) return 'iPhone'
	if (platform.startsWith('android') || ua.includes('android')) return 'Android'
	if (platform.startsWith('windows') || ua.includes('windows')) return 'Windows'
	if (platform.startsWith('mac') || platform.includes('darwin') || ua.includes('macos')) return 'Mac'
	if (platform.startsWith('linux') || ua.includes('linux')) return 'Linux'
	return null
}

interface Candidate {
	user: RemnawaveUser
	incrementBytes: number
	/** За сколько минут набран прирост (реальная длина окна по точкам). */
	windowMinutes: number
	/** Последняя точка: с неё начинаем новый час после предупреждения. */
	latestBytes: number
}

/** Результат расчёта прироста трафика пользователя за окно. */
type GrowthResult =
	| { kind: 'ok'; incrementBytes: number; windowMinutes: number }
	| { kind: 'insufficient-history' }
	| { kind: 'counter-reset' }

const evaluateGrowth = (store: StateStore, userId: number, windowMs: number): GrowthResult => {
	const samples = store.getSamples(userId)
	if (samples.length < 2) return { kind: 'insufficient-history' }

	const oldest = samples[0]!
	const latest = samples[samples.length - 1]!
	const cutoff = latest.t - windowMs

	// Самая старая точка в истории всё ещё внутри окна — значит, процесс не
	// работал достаточно долго (или пользователь только появился), чтобы
	// покрыть полное окно. Копим данные дальше, не оцениваем.
	if (oldest.t > cutoff) return { kind: 'insufficient-history' }

	// Якорь сильно старше окна — был перерыв в опросах (сервис или панель
	// лежали). Иначе трафик за несколько часов сравнили бы с лимитом за час.
	// Через windowMs якорь обновится сам.
	if (latest.t - oldest.t > windowMs * MAX_WINDOW_STRETCH) return { kind: 'insufficient-history' }

	const delta = latest.b - oldest.b
	if (delta < 0) return { kind: 'counter-reset' }

	return { kind: 'ok', incrementBytes: delta, windowMinutes: Math.round((latest.t - oldest.t) / 60_000) }
}

export class TrafficGuard {
	private readonly client: RemnawaveClient
	private readonly store: StateStore
	private readonly notifier: TelegramNotifier

	constructor(private readonly config: Config) {
		this.client = new RemnawaveClient(config)
		this.store = new StateStore(config.stateFilePath)
		this.notifier = new TelegramNotifier(config)
	}

	start(): void {
		this.store.load()
		logger.info('remnawave-traffic-guard запущен', {
			limit: formatGb(this.config.trafficLimitBytes),
			windowMinutes: this.config.windowMs / 60_000,
			pollIntervalSeconds: this.config.pollIntervalMs / 1000,
		})

		void this.runCycle() // первый прогон сразу, не дожидаясь первого интервала
		this.timer = setInterval(() => void this.runCycle(), this.config.pollIntervalMs)
	}

	private timer: NodeJS.Timeout | undefined

	stop(): void {
		if (this.timer) clearInterval(this.timer)
	}

	async runCycle(): Promise<void> {
		const now = Date.now()
		const candidates: Candidate[] = []
		let scannedActive = 0
		let scannedTotal = 0

		try {
			for await (const page of this.client.iterateAllUsers(this.config.pageSize)) {
				for (const user of page) {
					scannedTotal++
					const bytes = user.userTraffic.lifetimeUsedTrafficBytes

					// Историю храним только активным: из ~56 тыс. пользователей активны
					// ~3,5 тыс., иначе файл состояния раздувается в 15 раз.
					if (user.status !== 'ACTIVE') {
						this.store.forgetUser(user.id)
						continue
					}

					this.store.recordSample(user.id, { t: now, b: bytes }, this.config.windowMs)
					const growth = evaluateGrowth(this.store, user.id, this.config.windowMs)

					if (growth.kind === 'counter-reset') {
						logger.info('Обнаружен сброс накопительного счётчика трафика, перезапускаю историю', {
							userId: user.id,
							username: user.username,
						})
						this.store.resetUser(user.id, { t: now, b: bytes })
						continue
					}

					if (growth.kind === 'insufficient-history') continue

					scannedActive++

					if (growth.incrementBytes >= this.config.trafficLimitBytes) {
						candidates.push({
							user,
							incrementBytes: growth.incrementBytes,
							windowMinutes: growth.windowMinutes,
							latestBytes: bytes,
						})
					}
				}
			}
		} catch (error) {
			logger.error('Прогон остановлен из-за ошибки запроса к Remnawave, попробую в следующий раз', {
				error: String(error),
			})
			return // не трогаем state.persist() с частично собранными данными этого прогона
		}

		this.store.pruneStaleUsers(STALE_USER_MAX_AGE_MS, now)
		this.store.pruneOldStrikes(this.config.strikeResetMs, now)
		this.store.persist()

		logger.info('Прогон завершён', {
			durationSec: Math.round((Date.now() - now) / 1000),
			scannedTotal,
			scannedActive,
			candidates: candidates.length,
		})

		if (candidates.length === 0) return

		if (this.isCircuitBreakerTripped(candidates.length, scannedActive)) {
			await this.handleCircuitBreaker(candidates, scannedActive)
			return
		}

		await this.handleCandidates(candidates, now)
	}

	private isCircuitBreakerTripped(candidatesCount: number, scannedActive: number): boolean {
		if (candidatesCount > this.config.circuitBreakerMaxUsers) return true
		if (scannedActive === 0) return false
		const percent = (candidatesCount / scannedActive) * 100
		return percent > this.config.circuitBreakerMaxPercent
	}

	private async handleCircuitBreaker(candidates: Candidate[], scannedActive: number): Promise<void> {
		const percent = scannedActive > 0 ? ((candidates.length / scannedActive) * 100).toFixed(1) : 'н/д'

		logger.error('ПРЕДОХРАНИТЕЛЬ: слишком много кандидатов на отключение за один проход, никого не трогаю', {
			candidates: candidates.length,
			scannedActive,
			percent,
		})

		appendActionLog(this.config.actionsLogPath, {
			t: new Date().toISOString(),
			action: 'circuit-breaker',
			reason: `${candidates.length} кандидатов из ${scannedActive} активных (${percent}%)`,
		})

		const list = candidates
			.slice(0, 20)
			.map((c) => `• ${this.describeUser(c.user)} — +${formatGb(c.incrementBytes)}`)
			.join('\n')
		const more = candidates.length > 20 ? `\n…и ещё ${candidates.length - 20}` : ''

		await this.notifier.send(
			'🛑 <b>remnawave-traffic-guard: предохранитель сработал</b>\n\n' +
				`Под предупреждение или отключение попало <b>${candidates.length}</b> из ${scannedActive} активных пользователей (${percent}%).\n` +
				`Это больше лимита (абсолютный: ${this.config.circuitBreakerMaxUsers}, процентный: ${this.config.circuitBreakerMaxPercent}%).\n` +
				'Никого не отключаю — похоже, что-то сломалось (сброс счётчиков в панели, баг в правиле, аномальный трафик у всех и т.п.). Проверь вручную.\n\n' +
				`${list}${more}`,
		)
	}

	/**
	 * Каждое превышение — «страйк». Первые warningsBeforeBlock страйков —
	 * предупреждения, следующий — отключение. После предупреждения окно
	 * пользователя начинается заново: следующее предупреждение возможно только
	 * за новый полный час. Через strikeResetMs после первого предупреждения счётчик
	 * обнуляется.
	 */
	private async handleCandidates(candidates: Candidate[], now: number): Promise<void> {
		const report: string[] = []
		const failed: { candidate: Candidate; error: string }[] = []
		const nodeNames = await this.loadNodeNames()
		const limit = this.config.warningsBeforeBlock

		for (const candidate of candidates) {
			const { user, incrementBytes } = candidate
			const prev = this.store.getStrike(user.id)
			const isFresh = prev !== undefined && now - prev.firstAt <= this.config.strikeResetMs
			const strike = (isFresh ? prev.count : 0) + 1
			const firstAt = isFresh ? prev.firstAt : now
			const isBlock = strike > limit

			if (isBlock) {
				try {
					await this.client.disableUser(user.id)
				} catch (error) {
					logger.error('Не удалось отключить пользователя', {
						userId: user.id,
						username: user.username,
						error: String(error),
					})
					failed.push({ candidate, error: String(error) })
					continue // окно не сбрасываем — попробуем на следующем проходе
				}
				// После ручного включения поддержкой человек начинает с чистого листа
				this.store.clearStrike(user.id)
			} else {
				this.store.setStrike(user.id, { count: strike, firstAt, lastAt: now })
			}
			this.store.resetUser(user.id, { t: now, b: candidate.latestBytes })

			const level: CardLevel = isBlock ? 'blocked' : strike === limit ? 'last-warning' : 'warning'
			const resetAt = new Date(firstAt + this.config.strikeResetMs)
			const notifyError = await this.notifyUser(candidate, level, strike, resetAt, nodeNames)

			const logFields = {
				userId: user.id,
				username: user.username,
				telegramId: user.telegramId,
				strike,
				incrementGb: formatGb(incrementBytes),
				notifyError,
			}
			if (isBlock) logger.warn('Пользователь отключён после предупреждений', logFields)
			else logger.warn(`Предупреждение ${strike} из ${limit} за превышение трафика`, logFields)

			appendActionLog(this.config.actionsLogPath, {
				t: new Date().toISOString(),
				action: isBlock ? 'disable' : 'warning',
				userId: user.id,
				username: user.username,
				telegramId: user.telegramId,
				incrementBytes,
				strike,
				...(notifyError && { notifyError }),
			})

			const title = isBlock ? '⛔️ Отключил' : `⚠️ Предупреждение ${strike}/${limit}`
			const delivery = notifyError ? `❌ не доставлено: ${escapeHtml(notifyError.slice(0, 80))}` : '✉️ доставлено'
			report.push(
				`${title}: ${this.describeUser(user)} — ${formatGb(incrementBytes)} за ${candidate.windowMinutes} мин · ${delivery}`,
			)
		}

		this.store.persist()
		await this.sendSummary(report, failed)
	}

	/** Карточка + текст пользователю в основного бота. Возвращает ошибку или undefined. */
	private async notifyUser(
		candidate: Candidate,
		level: CardLevel,
		strike: number,
		resetAt: Date,
		nodeNames: Map<string, string>,
	): Promise<string | undefined> {
		const { user } = candidate
		if (!user.telegramId) return 'нет telegramId'

		try {
			const nodeUuid = user.userTraffic.lastConnectedNodeUuid
			const server = (nodeUuid && nodeNames.get(nodeUuid)) || '—'
			const devices = await this.loadDevices(user.id)
			const common = {
				level,
				step: strike,
				totalWarnings: this.config.warningsBeforeBlock,
				usedBytes: candidate.incrementBytes,
				limitBytes: this.config.trafficLimitBytes,
				windowMinutes: candidate.windowMinutes,
			}
			const png = renderCard({ ...common, server, devices, at: new Date() })
			const caption = buildUserCaption({ ...common, strikeResetDays: this.config.strikeResetDays, resetAt })
			const button = level === 'blocked' ? { text: 'Написать в поддержку', url: this.config.supportUrl } : undefined
			const error = await this.notifier.sendPhoto(user.telegramId, png, caption, button)
			return error ?? undefined
		} catch (error) {
			return String(error)
		}
	}

	/** uuid ноды → страна по-русски. Ошибка панели не должна мешать предупреждению. */
	private async loadNodeNames(): Promise<Map<string, string>> {
		try {
			const nodes = await this.client.getNodes()
			return new Map(nodes.map((n) => [n.uuid, COUNTRY_NAMES[n.countryCode?.toUpperCase()] ?? n.countryCode ?? '—']))
		} catch (error) {
			logger.warn('Не удалось получить список нод для карточки', { error: String(error) })
			return new Map()
		}
	}

	private async loadDevices(userId: number): Promise<string> {
		try {
			const labels = (await this.client.getHwidDevices(userId)).map(deviceLabel).filter((l): l is string => !!l)
			let unique = [...new Set(labels)]
			// «iPhone» без модели рядом с «iPhone 15» — скорее всего тот же телефон
			if (unique.some((l) => /^iPhone /.test(l))) unique = unique.filter((l) => l !== 'iPhone')
			return unique.length > 0 ? unique.join(', ') : '—'
		} catch {
			return '—'
		}
	}

	private async sendSummary(report: string[], failed: { candidate: Candidate; error: string }[]): Promise<void> {
		if (report.length === 0 && failed.length === 0) return

		const lines: string[] = [
			`🛡 <b>traffic-guard</b> · лимит ${formatGb(this.config.trafficLimitBytes)} / ${this.config.windowMs / 60_000} мин`,
			'',
			...report,
		]
		if (failed.length > 0) {
			lines.push('', `Не удалось отключить (${failed.length}):`)
			for (const f of failed) {
				lines.push(`• ${this.describeUser(f.candidate.user)} — ${escapeHtml(f.error)}`)
			}
		}

		await this.notifier.send(lines.join('\n'))
	}

	private describeUser(user: RemnawaveUser): string {
		const parts = [`id=${user.id}`, user.username]
		if (user.telegramId) parts.push(`tg=${user.telegramId}`)
		return parts.join(' ')
	}
}
