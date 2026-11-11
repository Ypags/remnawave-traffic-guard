import type { Config } from './config.js'

/**
 * Клиент Remnawave Panel API.
 *
 * Пути и формат ответов сверены с исходниками remnawave/backend (v3.4.5,
 * https://github.com/remnawave/backend):
 *  - libs/contract/api/routes.ts            — REST_API.USERS.*
 *  - libs/contract/models/extended-users.schema.ts — форма пользователя
 *  - libs/contract/models/user-traffic.schema.ts    — usedTrafficBytes / lifetimeUsedTrafficBytes
 *  - libs/contract/constants/users/status/status.constant.ts — ACTIVE/DISABLED/LIMITED/EXPIRED
 *
 * Важно: `userTraffic.usedTrafficBytes` обнуляется при периодическом сбросе
 * (trafficLimitStrategy), а `userTraffic.lifetimeUsedTrafficBytes` — счётчик
 * за всё время, который сброс не трогает. Именно по его приросту мы считаем
 * скользящее окно.
 */

export type RemnawaveUserStatus = 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED'

export interface RemnawaveUser {
	id: number
	shortUuid: string
	username: string
	status: RemnawaveUserStatus
	telegramId: number | null
	trafficLimitBytes: number
	userTraffic: {
		usedTrafficBytes: number
		lifetimeUsedTrafficBytes: number
		onlineAt: string | null
		firstConnectedAt: string | null
		lastConnectedNodeUuid?: string | null
	}
}

export interface RemnawaveNode {
	uuid: string
	name: string
	countryCode: string
}

export interface RemnawaveHwidDevice {
	platform: string | null
	osVersion: string | null
	deviceModel: string | null
	userAgent: string | null
}

interface GetUsersResponse {
	response: {
		users: RemnawaveUser[]
		total: number
	}
}

interface UserResponse {
	response: RemnawaveUser
}

export class RemnawaveApiError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly body?: string,
	) {
		super(message)
		this.name = 'RemnawaveApiError'
	}
}

export class RemnawaveClient {
	constructor(private readonly config: Config) {}

	private buildHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.config.remnawaveApiToken}`,
			'Content-Type': 'application/json',
			...(this.config.cfClientId && { 'CF-Access-Client-Id': this.config.cfClientId }),
			...(this.config.cfClientSecret && {
				'CF-Access-Client-Secret': this.config.cfClientSecret,
			}),
		}
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs)

		try {
			const res = await fetch(`${this.config.remnawaveUrl}${path}`, {
				...init,
				headers: { ...this.buildHeaders(), ...(init.headers as Record<string, string>) },
				signal: controller.signal,
			})

			const text = await res.text()

			if (!res.ok) {
				throw new RemnawaveApiError(
					`Remnawave API ответил ${res.status} на ${path}`,
					res.status,
					text.slice(0, 500),
				)
			}

			return text ? (JSON.parse(text) as T) : (undefined as T)
		} catch (error) {
			if (error instanceof RemnawaveApiError) throw error
			if (controller.signal.aborted) {
				throw new RemnawaveApiError(`Таймаут запроса к Remnawave: ${path}`)
			}
			throw new RemnawaveApiError(`Ошибка запроса к Remnawave (${path}): ${String(error)}`)
		} finally {
			clearTimeout(timeout)
		}
	}

	/**
	 * Одна страница списка пользователей. GET /api/users?start=&size=[&filters=]
	 * status — отдать только пользователей с этим статусом (фильтр на стороне панели).
	 */
	async getUsersPage(
		start: number,
		size: number,
		status?: RemnawaveUserStatus,
	): Promise<{ users: RemnawaveUser[]; total: number }> {
		const filters = status
			? `&filters=${encodeURIComponent(JSON.stringify([{ id: 'status', value: status }]))}`
			: ''
		const data = await this.request<GetUsersResponse>(`/api/users?start=${start}&size=${size}${filters}`)
		return { users: data.response.users, total: data.response.total }
	}

	/**
	 * Выгрузить пользователей постранично. С status панель отдаёт только их:
	 * ~3,5 тыс. активных вместо ~57 тыс. всех — 4 запроса вместо 57 и в 16 раз
	 * меньше трафика с панели (проверено на 3.4.8: без дублей и пропусков).
	 */
	async *iterateAllUsers(pageSize: number, status?: RemnawaveUserStatus): AsyncGenerator<RemnawaveUser[]> {
		let start = 0
		let total = Infinity

		while (start < total) {
			const page = await this.getUsersPage(start, pageSize, status)
			total = page.total
			yield page.users
			start += pageSize
			if (page.users.length === 0) break // защита от бесконечного цикла при неожиданном ответе
		}
	}

	/** POST /api/users/{userId}/actions/disable */
	async disableUser(userId: number): Promise<RemnawaveUser> {
		const data = await this.request<UserResponse>(`/api/users/${userId}/actions/disable`, {
			method: 'POST',
		})
		return data.response
	}

	/** POST /api/users/{userId}/actions/enable */
	async enableUser(userId: number): Promise<RemnawaveUser> {
		const data = await this.request<UserResponse>(`/api/users/${userId}/actions/enable`, {
			method: 'POST',
		})
		return data.response
	}

	/** GET /api/nodes — для названия страны сервера в карточке. */
	async getNodes(): Promise<RemnawaveNode[]> {
		const data = await this.request<{ response: RemnawaveNode[] }>('/api/nodes')
		return data.response
	}

	/** GET /api/hwid/devices/{userId} — устройства пользователя для карточки. */
	async getHwidDevices(userId: number): Promise<RemnawaveHwidDevice[]> {
		const data = await this.request<{ response: { devices: RemnawaveHwidDevice[] } }>(`/api/hwid/devices/${userId}`)
		return data.response.devices
	}

	/** GET /api/users/{userId} — для утилиты unblock, чтобы показать текущий статус. */
	async getUserById(userId: number): Promise<RemnawaveUser> {
		const data = await this.request<UserResponse>(`/api/users/${userId}`)
		return data.response
	}
}
