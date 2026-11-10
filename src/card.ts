import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js'

/**
 * Картинка-карточка для уведомления пользователя о превышении трафика.
 * Рисуем SVG и превращаем его в PNG через resvg (без браузера и нативных
 * зависимостей). Шрифт Manrope лежит в assets/fonts.
 */

const WIDTH = 1440
const HEIGHT = 810
const PAD = 80
const FONT = 'Manrope'

const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
const fontFiles = readdirSync(FONTS_DIR)
	.filter((f) => f.endsWith('.ttf'))
	.map((f) => join(FONTS_DIR, f))

const resvgOptions: ResvgRenderOptions = {
	font: { fontFiles, loadSystemFonts: false, defaultFontFamily: FONT },
}

const COLORS = {
	bg: '#060A14',
	glow: '#2E8BFF',
	text: '#FFFFFF',
	muted: '#8A93A6',
	soft: '#B9C1D1',
	track: '#1A2132',
	divider: '#1C2333',
	blueDeep: '#2E6BFF',
	blue: '#4FB8FF',
}

export type CardLevel = 'warning' | 'last-warning' | 'blocked'

const LEVEL_STYLE: Record<CardLevel, { accent: string; badge: (step: number, total: number) => string }> = {
	warning: { accent: '#4FB8FF', badge: (step, total) => `Предупреждение ${step} из ${total}` },
	'last-warning': { accent: '#FFB547', badge: (step, total) => `Последнее · ${step} из ${total}` },
	blocked: { accent: '#FF5C6C', badge: () => 'Доступ приостановлен' },
}

export interface CardData {
	level: CardLevel
	/** Номер предупреждения (для level=warning). */
	step: number
	/** Сколько всего предупреждений до блокировки. */
	totalWarnings: number
	usedBytes: number
	limitBytes: number
	windowMinutes: number
	server: string
	devices: string
	at: Date
}

const GB = 1024 * 1024 * 1024

const escapeXml = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** «57,3» — одна цифра после запятой, русская запятая. */
export const formatGbShort = (bytes: number): string => (bytes / GB).toFixed(1).replace('.', ',')

const textWidth = (text: string, size: number, weight: number): number => {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * 2}" height="${size * 2}">` +
		`<text x="0" y="${size * 1.5}" font-family="${FONT}" font-size="${size}" font-weight="${weight}">${escapeXml(text)}</text></svg>`
	const bbox = new Resvg(svg, resvgOptions).getBBox()
	return bbox ? bbox.width : text.length * size * 0.6
}

/** Обрезает строку с многоточием, чтобы она влезла в maxWidth. */
const fitText = (text: string, size: number, weight: number, maxWidth: number): string => {
	if (textWidth(text, size, weight) <= maxWidth) return text
	let cut = text
	while (cut.length > 1 && textWidth(`${cut}…`, size, weight) > maxWidth) cut = cut.slice(0, -1)
	return `${cut.trimEnd()}…`
}

const formatMoscowTime = (date: Date): string => {
	const parts = new Intl.DateTimeFormat('ru-RU', {
		timeZone: 'Europe/Moscow',
		day: '2-digit',
		month: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).formatToParts(date)
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
	return `${get('day')}.${get('month')} ${get('hour')}:${get('minute')} МСК`
}

const text = (
	x: number,
	y: number,
	content: string,
	size: number,
	weight: number,
	fill: string,
	anchor: 'start' | 'middle' | 'end' = 'start',
	letterSpacing = 0,
): string =>
	`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${letterSpacing}">${escapeXml(content)}</text>`

export const buildCardSvg = (data: CardData): string => {
	const style = LEVEL_STYLE[data.level]
	const accent = style.accent

	// Шапка: название и плашка уровня справа
	const badgeText = style.badge(data.step, data.totalWarnings)
	const badgeSize = 34
	const badgeW = textWidth(badgeText, badgeSize, 600) + 64
	const badgeH = 68
	const badgeX = WIDTH - PAD - badgeW
	const badgeY = 62

	// Полоса: шкала с запасом, чтобы отметка лимита стояла примерно на 3/4.
	// Не дальше 1.6 лимита: иначе подпись лимита наедет на текст слева.
	const barX = PAD
	const barY = 438
	const barW = WIDTH - PAD * 2
	const barH = 34
	const scaleMax = Math.min(data.limitBytes * 1.6, Math.max(data.limitBytes * 1.36, data.usedBytes * 1.08))
	const fillW = Math.max(barH, Math.min(1, data.usedBytes / scaleMax) * barW)
	const limitX = barX + (data.limitBytes / scaleMax) * barW
	const limitStop = Math.min(1, (limitX - barX) / fillW)

	const overBytes = Math.max(0, data.usedBytes - data.limitBytes)
	const percent = Math.round((data.usedBytes / data.limitBytes) * 100)
	const limitGb = Math.round(data.limitBytes / GB)

	const colW = (WIDTH - PAD * 2) / 2
	const server = fitText(data.server, 46, 600, colW - 40)
	const devices = fitText(data.devices, 46, 600, colW)

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
	<defs>
		<radialGradient id="glow" cx="${WIDTH}" cy="0" r="900" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="${COLORS.glow}" stop-opacity="0.42"/>
			<stop offset="0.45" stop-color="${COLORS.glow}" stop-opacity="0.12"/>
			<stop offset="1" stop-color="${COLORS.glow}" stop-opacity="0"/>
		</radialGradient>
		<linearGradient id="bar" x1="${barX}" y1="0" x2="${barX + fillW}" y2="0" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="${COLORS.blueDeep}"/>
			<stop offset="${(limitStop * 0.85).toFixed(3)}" stop-color="${COLORS.blue}"/>
			<stop offset="1" stop-color="${accent}"/>
		</linearGradient>
	</defs>
	<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>
	<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>

	${text(PAD, 116, 'GraniVPN · контроль трафика', 38, 500, COLORS.muted)}
	<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" fill="${accent}" fill-opacity="0.1" stroke="${accent}" stroke-width="3"/>
	${text(badgeX + badgeW / 2, badgeY + 46, badgeText, badgeSize, 600, accent, 'middle')}

	${text(PAD - 6, 322, `${formatGbShort(data.usedBytes)} ГБ`, 190, 800, COLORS.text, 'start', -5)}
	${text(PAD, 394, `скачано через VPN за ${data.windowMinutes} минут`, 44, 500, COLORS.soft)}

	<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${COLORS.track}"/>
	<rect x="${barX}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="url(#bar)"/>
	<rect x="${limitX - 3}" y="${barY - 16}" width="6" height="${barH + 32}" rx="3" fill="${COLORS.text}"/>
	${text(limitX, barY + barH + 66, `лимит ${limitGb} ГБ в час`, 32, 500, COLORS.text, 'middle')}

	${text(PAD, barY + barH + 66, `+${formatGbShort(overBytes)} ГБ сверх лимита · ${percent}%`, 34, 600, accent)}

	<rect x="${PAD}" y="${600}" width="${WIDTH - PAD * 2}" height="2" fill="${COLORS.divider}"/>

	${text(PAD, 672, 'Сервер', 32, 500, COLORS.muted)}
	${text(PAD, 730, server, 46, 600, COLORS.text)}
	${text(PAD + colW, 672, 'Устройства', 32, 500, COLORS.muted)}
	${text(PAD + colW, 730, devices, 46, 600, COLORS.text)}
	${text(WIDTH - PAD, 778, formatMoscowTime(data.at), 26, 500, '#5D6577', 'end')}
</svg>`
}

export const renderCard = (data: CardData): Buffer => new Resvg(buildCardSvg(data), resvgOptions).render().asPng()
