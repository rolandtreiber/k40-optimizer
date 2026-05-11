import { type ChangeEvent, type MouseEvent, useMemo, useRef, useState } from 'react'
import './App.css'

type ToolMode = 'measure' | 'cut' | 'engrave'

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
  const svg = preview?.querySelector('svg') as SVGSVGElement | null
  if (!svg) {
    return null
  }

  const matrix = svg.getScreenCTM()
  if (!matrix) {
    return null
  }

  const point = svg.createSVGPoint()
  point.x = event.clientX
  point.y = event.clientY
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
  const placements: Placement[] = []
  let sheet = 0
  let cursorX = gap
  let cursorY = gap
  let rowHeight = 0

  items.forEach((item) => {
    const width = Math.min(item.width, BED_WIDTH_MM - gap * 2)
    const height = Math.min(item.height, BED_HEIGHT_MM - gap * 2)

    if (cursorX + width + gap > BED_WIDTH_MM) {
      cursorX = gap
      cursorY += rowHeight + gap
      rowHeight = 0
    }

    if (cursorY + height + gap > BED_HEIGHT_MM) {
      sheet += 1
      cursorX = gap
      cursorY = gap
      rowHeight = 0
    }

    placements.push({
      id: item.id,
      sheet,
      x: cursorX,
      y: cursorY,
      width: item.width,
      height: item.height,
    })

    cursorX += width + gap
    rowHeight = Math.max(rowHeight, height)
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
    const translateX = placement.x - box.x * sourceInfo.unitX
    const translateY = placement.sheet * BED_HEIGHT_MM + placement.y - box.y * sourceInfo.unitY
    wrapper.setAttribute(
      'transform',
      `translate(${translateX.toFixed(4)} ${translateY.toFixed(4)}) scale(${sourceInfo.unitX.toFixed(6)} ${sourceInfo.unitY.toFixed(6)})`,
    )
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
  onRename,
  onToggleVisibility,
}: {
  nodes: LayerNode[]
  onRename: (id: string, name: string) => void
  onToggleVisibility: (id: string, visible: boolean) => void
}) {
  function renderNode(node: LayerNode, depth: number) {
    return (
      <li className="layer-item" key={`${node.id}-${node.name}-${node.hidden}`}>
        <div className="layer-row" style={{ paddingLeft: `${depth * 14}px` }}>
          <button
            type="button"
            className={`icon-button visibility-toggle ${node.hidden ? 'muted' : ''}`}
            onClick={() => onToggleVisibility(node.id, node.hidden)}
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
  const [toolMode, setToolMode] = useState<ToolMode>('measure')
  const [selectedPoints, setSelectedPoints] = useState<Point[]>([])
  const [targetDistance, setTargetDistance] = useState('')
  const [gapMm, setGapMm] = useState(2)
  const [status, setStatus] = useState('Sample loaded')
  const previewRef = useRef<HTMLDivElement>(null)
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
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open that SVG.')
      }
    })
    reader.readAsText(file)
  }

  function handlePreviewClick(event: MouseEvent<HTMLDivElement>) {
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

  function applyDistanceScale() {
    const nextDistance = Number(targetDistance)
    if (!measuredDistance || !Number.isFinite(nextDistance) || nextDistance <= 0) {
      setStatus('Set two points and a target distance first')
      return
    }

    const scale = nextDistance / measuredDistance
    updateSvg((current) => normaliseSvg(scaleSvg(current, scale)), `Scaled artwork by ${scale.toFixed(4)}x`)
  }

  function runAutoLayout() {
    try {
      const result = autoLayoutSvg(svgText, previewRef.current, gapMm)
      commitSvg(
        normaliseSvg(result.text),
        `${result.placements.length} elements packed into ${result.sheetCount} sheet${result.sheetCount === 1 ? '' : 's'}`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auto layout failed')
    }
  }

  function resetSample() {
    commitSvg(normaliseSvg(sampleSvg), 'Sample loaded', true)
    setFileName('k40-sample.svg')
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
              dangerouslySetInnerHTML={{ __html: svgText }}
            />
            {selectedPoints.map((point, index) => (
              <span
                className="measurement-dot"
                key={`${point.x}-${point.y}-${index}`}
                style={{
                  left: `${((point.x - svgInfo.viewBox[0]) / svgInfo.viewBox[2]) * 100}%`,
                  top: `${((point.y - svgInfo.viewBox[1]) / svgInfo.viewBox[3]) * 100}%`,
                }}
              >
                {index + 1}
              </span>
            ))}
          </div>
        </section>

        <aside className="panel">
          <div className="panel-section layers-section">
            <h2>Layers</h2>
            <LayerTree
              nodes={layers}
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
