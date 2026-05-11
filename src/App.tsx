import {
  type ChangeEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'

type ToolMode = 'select' | 'measure' | 'cut' | 'engrave'

type SvgInfo = {
  widthMm: number
  heightMm: number
  viewBox: [number, number, number, number]
  unitX: number
  unitY: number
  elementCount: number
  rasterCount: number
}

type Point = {
  x: number
  y: number
}

type Placement = {
  id: string
  sheet: number
  x: number
  y: number
  width: number
  height: number
  placedWidth: number
  placedHeight: number
  rotation: 0 | 90
}

type HistoryState = {
  past: string[]
  present: string
  future: string[]
}

type LayerNode = {
  id: string
  elementId: string
  name: string
  tag: string
  hidden: boolean
  children: LayerNode[]
}

type LayoutPart = {
  id: string
  part: SVGElement
  box: DOMRect
}

type LayoutCluster = {
  id: string
  parts: LayoutPart[]
  box: DOMRect
}

type SelectedBox = {
  x: number
  y: number
  width: number
  height: number
}

type DragAction = 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | 'rotate'

type DragState = {
  action: DragAction
  pointerId: number
  startPoint: Point
  currentPoint: Point
  startBox: SelectedBox
  selectedIds: string[]
  uniform: boolean
}

type DragPreview = {
  dx: number
  dy: number
  scaleX: number
  scaleY: number
  rotation: number
  originX: number
  originY: number
}

const BED_WIDTH_MM = 300
const BED_HEIGHT_MM = 200
const CUT_RED = 'rgb(255, 0, 0)'
const ENGRAVE_BLUE = 'rgb(0, 0, 255)'
const GRAPHIC_SELECTOR =
  'path,line,polyline,polygon,rect,circle,ellipse,g,image,use,text'
const NON_PART_SELECTOR = 'defs,style,title,desc,metadata,symbol,clipPath,mask,pattern'
const MAX_HISTORY = 80

const sampleSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="130mm" viewBox="0 0 210 130">
  <title>K40 optimiser sample</title>
  <rect x="12" y="12" width="72" height="44" rx="2" fill="none" stroke="rgb(255, 0, 0)" stroke-width="0.15"/>
  <circle cx="30" cy="34" r="6" fill="none" stroke="rgb(0, 0, 255)" stroke-width="0.15"/>
  <circle cx="66" cy="34" r="6" fill="none" stroke="rgb(0, 0, 255)" stroke-width="0.15"/>
  <path d="M104 18h62l12 12v52h-74z" fill="none" stroke="#111" stroke-width="0.15"/>
  <path d="M116 42h50M116 54h38" fill="none" stroke="#777" stroke-width="0.2"/>
  <rect x="24" y="82" width="44" height="28" fill="#777"/>
  <path d="M92 88c16-20 42-20 58 0c-16 20-42 20-58 0z" fill="none" stroke="#111" stroke-width="0.15"/>
</svg>`

function parseLengthToMm(value: string | null, fallback: number) {
  if (!value) {
    return fallback
  }

  const match = value.trim().match(/^(-?\d*\.?\d+)([a-z%]*)$/i)
  if (!match) {
    return fallback
  }

  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  if (!Number.isFinite(amount)) {
    return fallback
  }

  if (unit === 'cm') return amount * 10
  if (unit === 'in') return amount * 25.4
  if (unit === 'pt') return (amount * 25.4) / 72
  if (unit === 'pc') return (amount * 25.4) / 6
  if (unit === 'px') return (amount * 25.4) / 96
  return amount
}

function readViewBox(svg: SVGSVGElement): [number, number, number, number] {
  const raw = svg.getAttribute('viewBox')
  if (raw) {
    const values = raw
      .split(/[\s,]+/)
      .map(Number)
      .filter((value) => Number.isFinite(value))

    if (values.length === 4 && values[2] > 0 && values[3] > 0) {
      return [values[0], values[1], values[2], values[3]]
    }
  }

  const width = parseLengthToMm(svg.getAttribute('width'), BED_WIDTH_MM)
  const height = parseLengthToMm(svg.getAttribute('height'), BED_HEIGHT_MM)
  return [0, 0, width, height]
}

function parseSvg(text: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(text, 'image/svg+xml')
  const error = doc.querySelector('parsererror')
  const svg = doc.documentElement

  if (error || svg.nodeName.toLowerCase() !== 'svg') {
    throw new Error('That file is not a readable SVG document.')
  }

  return { doc, svg: svg as unknown as SVGSVGElement }
}

function getSvgInfo(text: string): SvgInfo {
  const { svg } = parseSvg(text)
  const viewBox = readViewBox(svg)
  const widthMm = parseLengthToMm(svg.getAttribute('width'), viewBox[2])
  const heightMm = parseLengthToMm(svg.getAttribute('height'), viewBox[3])
  const elementCount = svg.querySelectorAll(GRAPHIC_SELECTOR).length
  const rasterCount = svg.querySelectorAll('image').length

  return {
    widthMm,
    heightMm,
    viewBox,
    unitX: widthMm / viewBox[2],
    unitY: heightMm / viewBox[3],
    elementCount,
    rasterCount,
  }
}

function serializeSvg(doc: Document) {
  return new XMLSerializer().serializeToString(doc)
}

function cleanSvgDocument(doc: Document) {
  doc.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((node) => {
    node.remove()
  })
}

function normaliseSvg(text: string) {
  const { doc, svg } = parseSvg(text)
  cleanSvgDocument(doc)

  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }

  const viewBox = readViewBox(svg)
  svg.setAttribute('viewBox', viewBox.join(' '))
  svg.setAttribute('width', `${parseLengthToMm(svg.getAttribute('width'), viewBox[2]).toFixed(3)}mm`)
  svg.setAttribute('height', `${parseLengthToMm(svg.getAttribute('height'), viewBox[3]).toFixed(3)}mm`)

  let nextId = 1
  svg.querySelectorAll(GRAPHIC_SELECTOR).forEach((element) => {
    if (!element.getAttribute('data-k40-id')) {
      element.setAttribute('data-k40-id', `k40-${nextId}`)
      nextId += 1
    }

    if (!element.getAttribute('data-k40-name')) {
      const id = element.getAttribute('id')
      element.setAttribute('data-k40-name', id || element.nodeName.toLowerCase())
    }
  })

  return serializeSvg(doc)
}

function getSheetCount(text: string) {
  const { svg } = parseSvg(text)
  const sheets = svg.querySelectorAll(':scope > g[data-k40-sheet]').length
  return Math.max(1, sheets)
}

function getLayerTree(text: string): LayerNode[] {
  const { svg } = parseSvg(text)

  function toNode(element: Element): LayerNode | null {
    if (!element.matches(GRAPHIC_SELECTOR)) {
      return null
    }

    const id = element.getAttribute('data-k40-id')
    if (!id) {
      return null
    }

    const tag = element.nodeName.toLowerCase()
    const children = Array.from(element.children)
      .map(toNode)
      .filter((node): node is LayerNode => Boolean(node))
    const name = element.getAttribute('data-k40-name') || element.getAttribute('id') || tag
    const hidden = element.getAttribute('display') === 'none' || element.getAttribute('visibility') === 'hidden'

    return {
      id,
      elementId: element.getAttribute('id') || '',
      name,
      tag,
      hidden,
      children,
    }
  }

  return Array.from(svg.children)
    .filter((child) => !child.matches(NON_PART_SELECTOR))
    .map(toNode)
    .filter((node): node is LayerNode => Boolean(node))
}

function slugifyId(value: string, fallback: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

function uniqueElementId(doc: Document, requested: string, currentElement: Element) {
  let candidate = requested
  let suffix = 2

  while (true) {
    const existing = doc.getElementById(candidate)
    if (!existing || existing === currentElement) {
      return candidate
    }

    candidate = `${requested}-${suffix}`
    suffix += 1
  }
}

function renameLayer(text: string, k40Id: string, name: string) {
  const { doc } = parseSvg(text)
  const element = doc.querySelector(`[data-k40-id="${CSS.escape(k40Id)}"]`) as SVGElement | null
  if (!element) {
    return text
  }

  const nextName = name.trim() || element.nodeName.toLowerCase()
  element.setAttribute('data-k40-name', nextName)
  element.setAttribute('id', uniqueElementId(doc, slugifyId(nextName, k40Id), element))
  return serializeSvg(doc)
}

function setLayerVisibility(text: string, k40Id: string, visible: boolean) {
  const { doc } = parseSvg(text)
  const element = doc.querySelector(`[data-k40-id="${CSS.escape(k40Id)}"]`) as SVGElement | null
  if (!element) {
    return text
  }

  if (visible) {
    element.removeAttribute('display')
    element.removeAttribute('data-k40-hidden')
  } else {
    element.setAttribute('display', 'none')
    element.setAttribute('data-k40-hidden', 'true')
  }

  return serializeSvg(doc)
}

function distanceInMm(pointA: Point, pointB: Point, info: SvgInfo) {
  const dx = (pointB.x - pointA.x) * info.unitX
  const dy = (pointB.y - pointA.y) * info.unitY
  return Math.hypot(dx, dy)
}

function formatMm(value: number) {
  return `${value.toFixed(value >= 100 ? 1 : 2)} mm`
}

function updateElementStroke(text: string, id: string, color: string) {
  const { doc } = parseSvg(text)
  const element = doc.querySelector(`[data-k40-id="${CSS.escape(id)}"]`) as SVGElement | null
  if (!element) {
    return text
  }

  if (element.nodeName.toLowerCase() === 'g') {
    element.querySelectorAll(GRAPHIC_SELECTOR).forEach((child) => {
      if (child.nodeName.toLowerCase() !== 'image') {
        child.setAttribute('stroke', color)
        child.setAttribute('fill', child.getAttribute('fill') === 'none' ? 'none' : child.getAttribute('fill') ?? 'none')
      }
    })
  } else if (element.nodeName.toLowerCase() !== 'image') {
    element.setAttribute('stroke', color)
    if (!element.getAttribute('fill')) {
      element.setAttribute('fill', 'none')
    }
  }

  return serializeSvg(doc)
}

function transformSelection(text: string, ids: string[], transform: string) {
  const { doc } = parseSvg(text)

  ids.forEach((id) => {
    const element = doc.querySelector(`[data-k40-id="${CSS.escape(id)}"]`) as SVGElement | null
    if (!element) {
      return
    }

    const existingTransform = element.getAttribute('transform')
    element.setAttribute(
      'transform',
      existingTransform ? `${transform} ${existingTransform}` : transform,
    )
  })

  return serializeSvg(doc)
}

function scaleSvg(text: string, scale: number) {
  const { doc, svg } = parseSvg(text)
  const scaleTransform = `scale(${scale.toFixed(6)})`

  Array.from(svg.childNodes).forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return
    }

    const element = node as Element
    if (element.matches(NON_PART_SELECTOR)) {
      return
    }

    const existingTransform = element.getAttribute('transform')
    element.setAttribute(
      'transform',
      existingTransform ? `${scaleTransform} ${existingTransform}` : scaleTransform,
    )
  })

  return serializeSvg(doc)
}

function getLocalPoint(event: MouseEvent<HTMLDivElement>, preview: HTMLDivElement | null) {
  return getSvgPoint(event.clientX, event.clientY, preview)
}

function getSvgPoint(clientX: number, clientY: number, preview: HTMLDivElement | null) {
  const svg = preview?.querySelector('svg') as SVGSVGElement | null
  if (!svg) {
    return null
  }

  const matrix = svg.getScreenCTM()
  if (!matrix) {
    return null
  }

  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  return point.matrixTransform(matrix.inverse())
}

function getClickableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null
  }

  return target.closest(GRAPHIC_SELECTOR) as SVGElement | null
}

function topLevelParts(svg: SVGSVGElement) {
  return Array.from(svg.children).filter((child) => {
    return !child.matches(NON_PART_SELECTOR)
  }) as SVGElement[]
}

function getElementBox(preview: HTMLDivElement, id: string) {
  const element = preview.querySelector(`[data-k40-id="${CSS.escape(id)}"]`) as SVGGraphicsElement | null
  if (!element || typeof element.getBBox !== 'function') {
    return null
  }

  try {
    return element.getBBox()
  } catch {
    return null
  }
}

function getSelectionBox(preview: HTMLDivElement | null, ids: string[]) {
  if (!preview || ids.length === 0) {
    return null
  }

  const boxes = ids
    .map((id) => getElementBox(preview, id))
    .filter((box): box is DOMRect => Boolean(box))

  if (boxes.length === 0) {
    return null
  }

  const box = unionBoxes(boxes)
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  }
}

function percentInViewBox(value: number, start: number, size: number) {
  return `${((value - start) / size) * 100}%`
}

function getResizeAnchor(action: DragAction, box: SelectedBox): Point {
  if (action === 'resize-nw') {
    return { x: box.x + box.width, y: box.y + box.height }
  }

  if (action === 'resize-ne') {
    return { x: box.x, y: box.y + box.height }
  }

  if (action === 'resize-sw') {
    return { x: box.x + box.width, y: box.y }
  }

  return { x: box.x, y: box.y }
}

function pointAngle(center: Point, point: Point) {
  return Math.atan2(point.y - center.y, point.x - center.x)
}

function toDegrees(radians: number) {
  return (radians * 180) / Math.PI
}

function resizePreview(action: DragAction, box: SelectedBox, point: Point, uniform: boolean) {
  const anchor = getResizeAnchor(action, box)
  let scaleX = Math.abs(point.x - anchor.x) / box.width
  let scaleY = Math.abs(point.y - anchor.y) / box.height

  if (uniform) {
    const scale = Math.max(scaleX, scaleY)
    scaleX = scale
    scaleY = scale
  }

  return {
    dx: 0,
    dy: 0,
    scaleX: Math.max(0.05, scaleX),
    scaleY: Math.max(0.05, scaleY),
    rotation: 0,
    originX: ((anchor.x - box.x) / box.width) * 100,
    originY: ((anchor.y - box.y) / box.height) * 100,
  }
}

function buildResizeTransform(action: DragAction, box: SelectedBox, point: Point, uniform: boolean) {
  const anchor = getResizeAnchor(action, box)
  const preview = resizePreview(action, box, point, uniform)

  return `translate(${anchor.x.toFixed(4)} ${anchor.y.toFixed(4)}) scale(${preview.scaleX.toFixed(6)} ${preview.scaleY.toFixed(6)}) translate(${(-anchor.x).toFixed(4)} ${(-anchor.y).toFixed(4)})`
}

function containsBox(outer: DOMRect, inner: DOMRect) {
  const tolerance = 0.001
  return (
    outer !== inner &&
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  )
}

function unionBoxes(boxes: DOMRect[]) {
  const minX = Math.min(...boxes.map((box) => box.x))
  const minY = Math.min(...boxes.map((box) => box.y))
  const maxX = Math.max(...boxes.map((box) => box.x + box.width))
  const maxY = Math.max(...boxes.map((box) => box.y + box.height))
  return new DOMRect(minX, minY, maxX - minX, maxY - minY)
}

function buildLayoutClusters(parts: LayoutPart[]): LayoutCluster[] {
  const parentById = new Map<string, string>()

  parts.forEach((part) => {
    const containers = parts
      .filter((candidate) => candidate.id !== part.id && containsBox(candidate.box, part.box))
      .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)

    const parent = containers[0]
    if (parent) {
      parentById.set(part.id, parent.id)
    }
  })

  function rootFor(part: LayoutPart) {
    let rootId = part.id
    const seen = new Set<string>()

    while (parentById.has(rootId) && !seen.has(rootId)) {
      seen.add(rootId)
      rootId = parentById.get(rootId)!
    }

    return rootId
  }

  const grouped = new Map<string, LayoutPart[]>()
  parts.forEach((part) => {
    const rootId = rootFor(part)
    grouped.set(rootId, [...(grouped.get(rootId) ?? []), part])
  })

  return Array.from(grouped.entries()).map(([id, clusterParts]) => ({
    id,
    parts: clusterParts,
    box: unionBoxes(clusterParts.map((part) => part.box)),
  }))
}

function packItems(
  items: Array<{ id: string; width: number; height: number }>,
  gap: number,
) {
  type CandidatePlacement = {
    sheet: number
    x: number
    y: number
    placedWidth: number
    placedHeight: number
    rotation: 0 | 90
    score: number
  }

  const placements: Placement[] = []
  const placedBySheet: Array<Array<Placement>> = [[]]

  function overlaps(sheetPlacements: Placement[], x: number, y: number, width: number, height: number) {
    return sheetPlacements.some((placed) => {
      return !(
        x + width + gap <= placed.x ||
        placed.x + placed.placedWidth + gap <= x ||
        y + height + gap <= placed.y ||
        placed.y + placed.placedHeight + gap <= y
      )
    })
  }

  function candidatePositions(sheetPlacements: Placement[]) {
    const xs = new Set([gap])
    const ys = new Set([gap])

    sheetPlacements.forEach((placed) => {
      xs.add(placed.x + placed.placedWidth + gap)
      xs.add(placed.x)
      ys.add(placed.y + placed.placedHeight + gap)
      ys.add(placed.y)
    })

    return Array.from(xs).flatMap((x) => Array.from(ys).map((y) => ({ x, y })))
  }

  items.forEach((item) => {
    let best: CandidatePlacement | null = null

    const orientations: Array<{ placedWidth: number; placedHeight: number; rotation: 0 | 90 }> = [
      { placedWidth: item.width, placedHeight: item.height, rotation: 0 },
      { placedWidth: item.height, placedHeight: item.width, rotation: 90 },
    ]

    for (let sheet = 0; sheet <= placedBySheet.length; sheet += 1) {
      const sheetPlacements = placedBySheet[sheet] ?? []
      const candidates = sheetPlacements.length === 0
        ? [{ x: gap, y: gap }]
        : candidatePositions(sheetPlacements)

      orientations.forEach((orientation) => {
        candidates.forEach(({ x, y }) => {
          if (
            x + orientation.placedWidth + gap > BED_WIDTH_MM ||
            y + orientation.placedHeight + gap > BED_HEIGHT_MM ||
            overlaps(sheetPlacements, x, y, orientation.placedWidth, orientation.placedHeight)
          ) {
            return
          }

          const usedWidth = Math.max(
            x + orientation.placedWidth,
            ...sheetPlacements.map((placed) => placed.x + placed.placedWidth),
          )
          const usedHeight = Math.max(
            y + orientation.placedHeight,
            ...sheetPlacements.map((placed) => placed.y + placed.placedHeight),
          )
          const score = sheet * 10_000_000 + usedHeight * 10_000 + usedWidth * 100 + y + x * 0.01

          if (!best || score < best.score) {
            best = {
              sheet,
              x,
              y,
              ...orientation,
              score,
            }
          }
        })
      })
    }

    const bestPlacement = best as CandidatePlacement | null
    const placement: Placement = bestPlacement
      ? {
          id: item.id,
          sheet: bestPlacement.sheet,
          x: bestPlacement.x,
          y: bestPlacement.y,
          width: item.width,
          height: item.height,
          placedWidth: bestPlacement.placedWidth,
          placedHeight: bestPlacement.placedHeight,
          rotation: bestPlacement.rotation,
        }
      : {
          id: item.id,
          sheet: placedBySheet.length,
          x: gap,
          y: gap,
          width: item.width,
          height: item.height,
          placedWidth: item.width,
          placedHeight: item.height,
          rotation: 0,
        }

    if (!placedBySheet[placement.sheet]) {
      placedBySheet[placement.sheet] = []
    }

    placedBySheet[placement.sheet].push(placement)
    placements.push(placement)
  })

  return placements
}

function autoLayoutSvg(text: string, preview: HTMLDivElement | null, gapMm: number) {
  if (!preview) {
    throw new Error('The preview is not ready yet.')
  }

  const source = parseSvg(text)
  const sourceInfo = getSvgInfo(text)
  const sourceParts = topLevelParts(source.svg)
    .filter((part) => part.getAttribute('display') !== 'none' && part.getAttribute('visibility') !== 'hidden')
    .map((part, index) => {
      const id = part.getAttribute('data-k40-id') ?? `part-${index}`
      part.setAttribute('data-k40-id', id)
      const box = getElementBox(preview, id)
      return { id, part, box }
    })

  const layoutParts = sourceParts.filter(
    (item): item is LayoutPart => Boolean(item.box),
  )
  const clusters = buildLayoutClusters(layoutParts)
  const packedParts = clusters
    .map((cluster) => ({
      id: cluster.id,
      width: cluster.box.width * sourceInfo.unitX,
      height: cluster.box.height * sourceInfo.unitY,
    }))
    .sort((a, b) => b.height * b.width - a.height * a.width)

  if (packedParts.length === 0) {
    throw new Error('No movable SVG elements were found.')
  }

  const placements = packItems(packedParts, gapMm)
  const sheetCount = Math.max(...placements.map((placement) => placement.sheet)) + 1
  const output = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg')
  const outputSvg = output.documentElement as unknown as SVGSVGElement
  outputSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  outputSvg.setAttribute('width', `${BED_WIDTH_MM}mm`)
  outputSvg.setAttribute('height', `${BED_HEIGHT_MM * sheetCount}mm`)
  outputSvg.setAttribute('viewBox', `0 0 ${BED_WIDTH_MM} ${BED_HEIGHT_MM * sheetCount}`)

  source.svg.querySelectorAll('defs,style').forEach((node) => {
    outputSvg.appendChild(output.importNode(node, true))
  })

  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
    const group = output.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('id', `sheet-${sheetIndex + 1}`)
    group.setAttribute('data-k40-sheet', String(sheetIndex + 1))
    outputSvg.appendChild(group)
  }

  placements.forEach((placement) => {
    const cluster = clusters.find((item) => item.id === placement.id)
    if (!cluster) {
      return
    }

    const sheetGroup = outputSvg.querySelector(`#sheet-${placement.sheet + 1}`)
    if (!sheetGroup) {
      return
    }

    const wrapper = output.createElementNS('http://www.w3.org/2000/svg', 'g')
    const box = cluster.box
    const targetY = placement.sheet * BED_HEIGHT_MM + placement.y
    const transform = placement.rotation === 90
      ? [
          `translate(${(placement.x + box.height * sourceInfo.unitY).toFixed(4)} ${targetY.toFixed(4)})`,
          'rotate(90)',
          `translate(${(-box.x * sourceInfo.unitX).toFixed(4)} ${(-box.y * sourceInfo.unitY).toFixed(4)})`,
          `scale(${sourceInfo.unitX.toFixed(6)} ${sourceInfo.unitY.toFixed(6)})`,
        ].join(' ')
      : [
          `translate(${(placement.x - box.x * sourceInfo.unitX).toFixed(4)} ${(targetY - box.y * sourceInfo.unitY).toFixed(4)})`,
          `scale(${sourceInfo.unitX.toFixed(6)} ${sourceInfo.unitY.toFixed(6)})`,
        ].join(' ')

    wrapper.setAttribute('transform', transform)
    cluster.parts.forEach((sourcePart) => {
      wrapper.appendChild(output.importNode(sourcePart.part, true))
    })
    sheetGroup.appendChild(wrapper)
  })

  return {
    text: serializeSvg(output),
    sheetCount,
    placements,
  }
}

function downloadSvg(text: string, fileName: string) {
  const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function LayerTree({
  nodes,
  selectedIds,
  onRename,
  onSelect,
  onToggleVisibility,
}: {
  nodes: LayerNode[]
  selectedIds: string[]
  onRename: (id: string, name: string) => void
  onSelect: (id: string, additive: boolean) => void
  onToggleVisibility: (id: string, visible: boolean) => void
}) {
  function renderNode(node: LayerNode, depth: number) {
    const isSelected = selectedIds.includes(node.id)

    return (
      <li className="layer-item" key={`${node.id}-${node.name}-${node.hidden}`}>
        <div
          className={`layer-row ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${depth * 14}px` }}
          onClick={(event) => onSelect(node.id, event.shiftKey || event.metaKey)}
        >
          <button
            type="button"
            className={`icon-button visibility-toggle ${node.hidden ? 'muted' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleVisibility(node.id, node.hidden)
            }}
            aria-label={node.hidden ? `Show ${node.name}` : `Hide ${node.name}`}
            title={node.hidden ? 'Show layer' : 'Hide layer'}
          >
            {node.hidden ? 'Off' : 'On'}
          </button>
          <span className="layer-tag">{node.tag}</span>
          <input
            className="layer-name"
            defaultValue={node.name}
            aria-label={`Layer name for ${node.name}`}
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => onRename(node.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
        </div>
        {node.children.length > 0 ? (
          <ul className="layer-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  return <ul className="layer-tree">{nodes.map((node) => renderNode(node, 0))}</ul>
}

function App() {
  const [history, setHistory] = useState<HistoryState>(() => ({
    past: [],
    present: normaliseSvg(sampleSvg),
    future: [],
  }))
  const [fileName, setFileName] = useState('k40-sample.svg')
  const [toolMode, setToolMode] = useState<ToolMode>('select')
  const [selectedPoints, setSelectedPoints] = useState<Point[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectionBox, setSelectionBox] = useState<SelectedBox | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [targetDistance, setTargetDistance] = useState('')
  const [gapMm, setGapMm] = useState(2)
  const [status, setStatus] = useState('Sample loaded')
  const previewRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const svgText = history.present

  const svgInfo = useMemo(() => getSvgInfo(svgText), [svgText])
  const sheetCount = useMemo(() => getSheetCount(svgText), [svgText])
  const layers = useMemo(() => getLayerTree(svgText), [svgText])
  const measuredDistance = selectedPoints.length === 2
    ? distanceInMm(selectedPoints[0], selectedPoints[1], svgInfo)
    : null
  const bedUsage = Math.min(
    100,
    ((svgInfo.widthMm * svgInfo.heightMm) / (BED_WIDTH_MM * BED_HEIGHT_MM)) * 100,
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSelectionBox(getSelectionBox(previewRef.current, selectedIds))
    })

    return () => cancelAnimationFrame(frame)
  }, [selectedIds, svgText])

  function commitSvg(nextText: string, nextStatus: string, reset = false) {
    setHistory((current) => {
      if (nextText === current.present) {
        return current
      }

      if (reset) {
        return { past: [], present: nextText, future: [] }
      }

      return {
        past: [...current.past.slice(-(MAX_HISTORY - 1)), current.present],
        present: nextText,
        future: [],
      }
    })
    setSelectedPoints([])
    setStatus(nextStatus)
  }

  function updateSvg(updater: (current: string) => string, nextStatus: string) {
    setHistory((current) => {
      const nextText = updater(current.present)
      if (nextText === current.present) {
        return current
      }

      return {
        past: [...current.past.slice(-(MAX_HISTORY - 1)), current.present],
        present: nextText,
        future: [],
      }
    })
    setSelectedPoints([])
    setStatus(nextStatus)
  }

  function undo() {
    setHistory((current) => {
      const previous = current.past.at(-1)
      if (!previous) {
        return current
      }

      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      }
    })
    setSelectedPoints([])
    setStatus('Undo')
  }

  function redo() {
    setHistory((current) => {
      const next = current.future[0]
      if (!next) {
        return current
      }

      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      }
    })
    setSelectedPoints([])
    setStatus('Redo')
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.addEventListener('load', () => {
      try {
        const text = String(reader.result ?? '')
        commitSvg(normaliseSvg(text), `${file.name} opened`, true)
        setFileName(file.name)
        setSelectedIds([])
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open that SVG.')
      }
    })
    reader.readAsText(file)
  }

  function handlePreviewClick(event: MouseEvent<HTMLDivElement>) {
    if (toolMode === 'select') {
      const target = getClickableTarget(event.target)
      const id = target?.getAttribute('data-k40-id')
      if (!id) {
        if (!event.shiftKey && !event.metaKey) {
          setSelectedIds([])
        }
        setStatus('Selection cleared')
        return
      }

      const isMultiSelect = event.shiftKey || event.metaKey
      setSelectedIds((current) => {
        if (!isMultiSelect) {
          return [id]
        }

        return current.includes(id)
          ? current.filter((selectedId) => selectedId !== id)
          : [...current, id]
      })
      setStatus(isMultiSelect ? 'Selection updated' : 'Element selected')
      return
    }

    if (toolMode === 'measure') {
      const point = getLocalPoint(event, previewRef.current)
      if (!point) {
        return
      }

      setSelectedPoints((current) => [...current.slice(-1), { x: point.x, y: point.y }])
      setStatus('Measurement point set')
      return
    }

    const target = getClickableTarget(event.target)
    const id = target?.getAttribute('data-k40-id')
    if (!id) {
      setStatus('Select an SVG outline')
      return
    }

    const color = toolMode === 'cut' ? CUT_RED : ENGRAVE_BLUE
    updateSvg(
      (current) => updateElementStroke(current, id, color),
      toolMode === 'cut' ? 'Outline marked for vector cut' : 'Outline marked for vector engrave',
    )
  }

  function handlePreviewPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (toolMode !== 'select' || !selectionBox) {
      return
    }

    const target = getClickableTarget(event.target)
    const id = target?.getAttribute('data-k40-id')
    if (id && selectedIds.includes(id)) {
      beginSelectionDrag(event, 'move')
    }
  }

  function applyDistanceScale() {
    const nextDistance = Number(targetDistance)
    if (!measuredDistance || !Number.isFinite(nextDistance) || nextDistance <= 0) {
      setStatus('Set two points and a target distance first')
      return
    }

    const scale = nextDistance / measuredDistance
    updateSvg((current) => normaliseSvg(scaleSvg(current, scale)), `Scaled artwork by ${scale.toFixed(4)}x`)
  }

  function beginSelectionDrag(event: PointerEvent<HTMLElement>, action: DragAction) {
    if (!selectionBox || selectedIds.length === 0 || toolMode !== 'select') {
      return
    }

    const startPoint = getSvgPoint(event.clientX, event.clientY, previewRef.current)
    if (!startPoint) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      action,
      pointerId: event.pointerId,
      startPoint,
      currentPoint: startPoint,
      startBox: selectionBox,
      selectedIds: [...selectedIds],
      uniform: event.shiftKey,
    }
    setStatus(action === 'move' ? 'Dragging selection' : 'Editing selection')
  }

  function updateSelectionDrag(event: PointerEvent<HTMLElement>) {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    const currentPoint = getSvgPoint(event.clientX, event.clientY, previewRef.current)
    if (!currentPoint) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    dragState.currentPoint = currentPoint

    if (dragState.action === 'move') {
      setDragPreview({
        dx: currentPoint.x - dragState.startPoint.x,
        dy: currentPoint.y - dragState.startPoint.y,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        originX: 50,
        originY: 50,
      })
      return
    }

    if (dragState.action === 'rotate') {
      const center = {
        x: dragState.startBox.x + dragState.startBox.width / 2,
        y: dragState.startBox.y + dragState.startBox.height / 2,
      }
      const startAngle = pointAngle(center, dragState.startPoint)
      const currentAngle = pointAngle(center, currentPoint)
      setDragPreview({
        dx: 0,
        dy: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: toDegrees(currentAngle - startAngle),
        originX: 50,
        originY: 50,
      })
      return
    }

    setDragPreview(resizePreview(dragState.action, dragState.startBox, currentPoint, dragState.uniform))
  }

  function endSelectionDrag(event: PointerEvent<HTMLElement>) {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.releasePointerCapture(event.pointerId)
    dragStateRef.current = null
    setDragPreview(null)

    const endPoint = getSvgPoint(event.clientX, event.clientY, previewRef.current) ?? dragState.currentPoint
    const movedDistance = Math.hypot(endPoint.x - dragState.startPoint.x, endPoint.y - dragState.startPoint.y)
    if (movedDistance < 0.01) {
      setStatus('Element selected')
      return
    }

    if (dragState.action === 'move') {
      const dx = endPoint.x - dragState.startPoint.x
      const dy = endPoint.y - dragState.startPoint.y
      updateSvg(
        (current) =>
          transformSelection(current, dragState.selectedIds, `translate(${dx.toFixed(4)} ${dy.toFixed(4)})`),
        'Selection moved',
      )
      return
    }

    if (dragState.action === 'rotate') {
      const center = {
        x: dragState.startBox.x + dragState.startBox.width / 2,
        y: dragState.startBox.y + dragState.startBox.height / 2,
      }
      const degrees = toDegrees(pointAngle(center, endPoint) - pointAngle(center, dragState.startPoint))
      updateSvg(
        (current) =>
          transformSelection(
            current,
            dragState.selectedIds,
            `rotate(${degrees.toFixed(3)} ${center.x.toFixed(4)} ${center.y.toFixed(4)})`,
          ),
        'Selection rotated',
      )
      return
    }

    updateSvg(
      (current) =>
        transformSelection(
          current,
          dragState.selectedIds,
          buildResizeTransform(dragState.action, dragState.startBox, endPoint, dragState.uniform),
        ),
      dragState.uniform ? 'Selection scaled' : 'Selection resized',
    )
  }

  function runAutoLayout() {
    try {
      const result = autoLayoutSvg(svgText, previewRef.current, gapMm)
      commitSvg(
        normaliseSvg(result.text),
        `${result.placements.length} elements packed into ${result.sheetCount} sheet${result.sheetCount === 1 ? '' : 's'}`,
      )
      setSelectedIds([])
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auto layout failed')
    }
  }

  function resetSample() {
    commitSvg(normaliseSvg(sampleSvg), 'Sample loaded', true)
    setFileName('k40-sample.svg')
    setSelectedIds([])
  }

  function renameLayerItem(id: string, name: string) {
    updateSvg((current) => renameLayer(current, id, name), 'Layer renamed')
  }

  function toggleLayerVisibility(id: string, currentlyHidden: boolean) {
    updateSvg(
      (current) => setLayerVisibility(current, id, currentlyHidden),
      currentlyHidden ? 'Layer shown' : 'Layer hidden',
    )
  }

  function selectLayer(id: string, additive: boolean) {
    setSelectedIds((current) => {
      if (!additive) {
        return [id]
      }

      return current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id]
    })
    setToolMode('select')
    setStatus(additive ? 'Selection updated' : 'Layer selected')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">K40 Whisperer SVG Optimiser</p>
          <h1>Laser-ready layout for a 300 x 200 mm bed</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={undo} disabled={history.past.length === 0}>
            Undo
          </button>
          <button type="button" onClick={redo} disabled={history.future.length === 0}>
            Redo
          </button>
          <label className="file-button">
            Open SVG
            <input type="file" accept=".svg,image/svg+xml" onChange={handleFileChange} />
          </label>
          <button type="button" onClick={() => downloadSvg(svgText, fileName.replace(/\.svg$/i, '') + '-k40.svg')}>
            Export SVG
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="panel">
          <div className="panel-section">
            <h2>Document</h2>
            <dl className="stats-grid">
              <div>
                <dt>Width</dt>
                <dd>{formatMm(svgInfo.widthMm)}</dd>
              </div>
              <div>
                <dt>Height</dt>
                <dd>{formatMm(svgInfo.heightMm)}</dd>
              </div>
              <div>
                <dt>Elements</dt>
                <dd>{svgInfo.elementCount}</dd>
              </div>
              <div>
                <dt>Raster</dt>
                <dd>{svgInfo.rasterCount}</dd>
              </div>
            </dl>
            <div className="usage-meter" aria-label={`Document footprint is ${bedUsage.toFixed(0)} percent of one K40 bed`}>
              <span style={{ width: `${bedUsage}%` }} />
            </div>
          </div>

          <div className="panel-section">
            <h2>Mode</h2>
            <div className="segmented">
              <button
                type="button"
                className={toolMode === 'select' ? 'active' : ''}
                onClick={() => setToolMode('select')}
              >
                Select
              </button>
              <button
                type="button"
                className={toolMode === 'measure' ? 'active' : ''}
                onClick={() => setToolMode('measure')}
              >
                Measure
              </button>
              <button
                type="button"
                className={toolMode === 'engrave' ? 'active' : ''}
                onClick={() => setToolMode('engrave')}
              >
                Vector engrave
              </button>
              <button
                type="button"
                className={toolMode === 'cut' ? 'active' : ''}
                onClick={() => setToolMode('cut')}
              >
                Vector cut
              </button>
            </div>
          </div>

          <div className="panel-section">
            <h2>Transform</h2>
            <div className="selection-summary">
              <span>Selected</span>
              <strong>{selectedIds.length}</strong>
            </div>
            {selectionBox ? (
              <div className="transform-readout">
                <span>{formatMm(selectionBox.width * svgInfo.unitX)}</span>
                <span>{formatMm(selectionBox.height * svgInfo.unitY)}</span>
              </div>
            ) : null}
          </div>

          <div className="panel-section">
            <h2>Scale</h2>
            <div className="readout">
              <span>Measured</span>
              <strong>{measuredDistance ? formatMm(measuredDistance) : 'Set 2 points'}</strong>
            </div>
            <label className="field">
              Target distance
              <div className="input-row">
                <input
                  type="number"
                  min="0.01"
                  step="0.1"
                  value={targetDistance}
                  onChange={(event) => setTargetDistance(event.target.value)}
                  placeholder="mm"
                />
                <button type="button" onClick={applyDistanceScale}>
                  Apply
                </button>
              </div>
            </label>
          </div>
        </aside>

        <section className="preview-column">
          <div className="bed-toolbar">
            <div>
              <strong>{fileName}</strong>
              <span>{sheetCount} sheet{sheetCount === 1 ? '' : 's'} · {status}</span>
            </div>
            <button type="button" onClick={resetSample}>
              Load sample
            </button>
          </div>
          <div className="bed-frame">
            <div className="bed-ruler x">300 mm</div>
            <div className="bed-ruler y">200 mm</div>
            <div
              ref={previewRef}
              className={`svg-preview mode-${toolMode}`}
              onClick={handlePreviewClick}
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={updateSelectionDrag}
              onPointerUp={endSelectionDrag}
              onPointerCancel={endSelectionDrag}
              dangerouslySetInnerHTML={{ __html: svgText }}
            />
            <div className="preview-overlay">
              {toolMode === 'select' && selectionBox ? (
                <span
                  className="selection-box"
                  onPointerDown={(event) => beginSelectionDrag(event, 'move')}
                  onPointerMove={updateSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                  style={{
                    left: percentInViewBox(selectionBox.x + (dragPreview?.dx ?? 0), svgInfo.viewBox[0], svgInfo.viewBox[2]),
                    top: percentInViewBox(selectionBox.y + (dragPreview?.dy ?? 0), svgInfo.viewBox[1], svgInfo.viewBox[3]),
                    width: `${(selectionBox.width / svgInfo.viewBox[2]) * 100}%`,
                    height: `${(selectionBox.height / svgInfo.viewBox[3]) * 100}%`,
                    transform: dragPreview
                      ? `scale(${dragPreview.scaleX}, ${dragPreview.scaleY}) rotate(${dragPreview.rotation}deg)`
                      : undefined,
                    transformOrigin: dragPreview
                      ? `${dragPreview.originX}% ${dragPreview.originY}%`
                      : undefined,
                  }}
                >
                  <span
                    className="resize-handle nw"
                    role="button"
                    tabIndex={0}
                    title="Resize"
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-nw')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <span
                    className="resize-handle ne"
                    role="button"
                    tabIndex={0}
                    title="Resize"
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-ne')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <span
                    className="resize-handle sw"
                    role="button"
                    tabIndex={0}
                    title="Resize"
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-sw')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <span
                    className="resize-handle se"
                    role="button"
                    tabIndex={0}
                    title="Resize"
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-se')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <span
                    className="rotate-handle"
                    role="button"
                    tabIndex={0}
                    title="Rotate"
                    onPointerDown={(event) => beginSelectionDrag(event, 'rotate')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                </span>
              ) : null}
              {selectedPoints.map((point, index) => (
                <span
                  className="measurement-target"
                  key={`${point.x}-${point.y}-${index}`}
                  style={{
                    left: percentInViewBox(point.x, svgInfo.viewBox[0], svgInfo.viewBox[2]),
                    top: percentInViewBox(point.y, svgInfo.viewBox[1], svgInfo.viewBox[3]),
                  }}
                >
                  <b>{index + 1}</b>
                </span>
              ))}
            </div>
          </div>
        </section>

        <aside className="panel">
          <div className="panel-section layers-section">
            <h2>Layers</h2>
            <LayerTree
              nodes={layers}
              selectedIds={selectedIds}
              onSelect={selectLayer}
              onRename={renameLayerItem}
              onToggleVisibility={toggleLayerVisibility}
            />
          </div>

          <div className="panel-section">
            <h2>K40 Mapping</h2>
            <div className="legend">
              <span><i className="swatch cut" />Red stroke</span>
              <strong>Vector cut</strong>
            </div>
            <div className="legend">
              <span><i className="swatch engrave" />Blue stroke</span>
              <strong>Vector engrave</strong>
            </div>
            <div className="legend">
              <span><i className="swatch raster" />Gray fill / image</span>
              <strong>Raster engrave</strong>
            </div>
          </div>

          <div className="panel-section">
            <h2>Sheets</h2>
            <label className="field">
              Part gap
              <div className="input-row">
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={gapMm}
                  onChange={(event) => setGapMm(Number(event.target.value))}
                />
                <span className="unit">mm</span>
              </div>
            </label>
            <button type="button" className="primary-action" onClick={runAutoLayout}>
              Auto-position elements
            </button>
          </div>

          <div className="panel-section">
            <h2>Export</h2>
            <button type="button" className="primary-action" onClick={() => downloadSvg(svgText, fileName.replace(/\.svg$/i, '') + '-k40.svg')}>
              Download K40 SVG
            </button>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App
