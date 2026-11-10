import type { CardLevel } from './card.js'
import { formatGbShort } from './card.js'

/**
 * Тексты уведомлений пользователю (подпись под картинкой, HTML).
 * Лимит подписи в Telegram — 1024 символа.
 */

export interface MessageData {
	level: CardLevel
	step: number
	totalWarnings: number
	usedBytes: number
	limitBytes: number
	windowMinutes: number
	strikeResetDays: number
	/** Когда счётчик обнулится (через strikeResetDays после первого предупреждения). */
	resetAt: Date
}

const GB = 1024 * 1024 * 1024

export const buildUserCaption = (d: MessageData): string => {
	const used = `<b>${formatGbShort(d.usedBytes)} ГБ</b>`
	const limit = `${Math.round(d.limitBytes / GB)} ГБ в час`

	const resetDate = d.resetAt.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' })
	const resetNote = `<i>Счётчик предупреждений обнулится ${resetDate} — через ${d.strikeResetDays} дней после первого.</i>`

	if (d.level === 'warning' && d.step === 1) {
		return [
			`⚠️ <b>Предупреждение 1 из ${d.totalWarnings}</b>`,
			'',
			`За последние ${d.windowMinutes} минут через ваш VPN прошло ${used}, а лимит — ${limit}.`,
			'',
			'Если вы разово скачали игру или большой файл, всё в порядке, ничего делать не нужно.',
			'',
			'Если такая нагрузка будет повторяться, придут ещё предупреждения, а после последнего доступ приостановится. ' +
				'Лимит нужен, чтобы VPN не тормозил у остальных: на каждом сервере сотни людей.',
			'',
			resetNote,
		].join('\n')
	}

	if (d.level === 'warning') {
		const left = d.totalWarnings - d.step
		return [
			`⚠️ <b>Предупреждение ${d.step} из ${d.totalWarnings}</b>`,
			'',
			`Нагрузка повторилась: ${used} за ${d.windowMinutes} минут при лимите ${limit}.`,
			'',
			`Это уже ${d.step}-е превышение. ${left === 1 ? 'Следующее будет последним предупреждением' : `Осталось предупреждений: ${left}`}, ` +
				'а после него доступ к VPN приостановится автоматически.',
			'',
			'Похоже, загрузки идут постоянно: торренты, игры, синхронизация облака. Поставьте их на паузу или растяните по времени.',
			'',
			resetNote,
		].join('\n')
	}

	if (d.level === 'last-warning') {
		return [
			`🟠 <b>Предупреждение ${d.step} из ${d.totalWarnings} — последнее</b>`,
			'',
			`Снова большая загрузка: ${used} за ${d.windowMinutes} минут при лимите ${limit}.`,
			'',
			'<b>Ещё одно превышение — и доступ к VPN приостановится автоматически.</b>',
			'',
			'Поставьте на паузу торренты, загрузку игр и синхронизацию облака или растяните их по времени. ' +
				'Видео, соцсети и онлайн-игры до лимита не доходят, их можно не трогать.',
			'',
			resetNote,
		].join('\n')
	}

	return [
		'⛔️ <b>Доступ приостановлен</b>',
		'',
		`Лимит снова превышен: ${used} за ${d.windowMinutes} минут. ` +
			`Мы предупреждали ${d.totalWarnings === 1 ? 'один раз' : `${d.totalWarnings} раза`}, поэтому подписка временно отключена.`,
		'',
		'Чтобы вернуть доступ, напишите в поддержку, разберёмся.',
	].join('\n')
}
