import {
  type ChangeEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
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
  preserveAspectRatio: string
}

type Point = {
  x: number
  y: number
}

type HistoryState = {
  past: string[]
  present: string
  future: string[]
}

type PermissionStateValue = 'granted' | 'denied' | 'prompt'

type LocalFilePermissionDescriptor = {
  mode?: 'read' | 'readwrite'
}

type LocalWritableFileStream = {
  write: (data: string) => Promise<void>
  close: () => Promise<void>
}

type LocalFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<LocalWritableFileStream>
  queryPermission?: (descriptor?: LocalFilePermissionDescriptor) => Promise<PermissionStateValue>
  requestPermission?: (descriptor?: LocalFilePermissionDescriptor) => Promise<PermissionStateValue>
}

type LocalDirectoryHandle = {
  kind: 'directory'
  name: string
  entries: () => AsyncIterableIterator<[string, LocalDirectoryHandle | LocalFileHandle]>
}

type FilePickerAcceptType = {
  description: string
  accept: Record<string, string[]>
}

type FileSystemWindow = Window & typeof globalThis & {
  showDirectoryPicker?: () => Promise<LocalDirectoryHandle>
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: FilePickerAcceptType[]
  }) => Promise<LocalFileHandle>
}

type FileBrowserItem = {
  id: string
  name: string
  path: string
  handle: LocalFileHandle
}

type SvgNestApi = {
  parsesvg: (svgString: string) => SVGSVGElement
  setbin: (element: Element) => void
  config: (config?: Record<string, unknown>) => Record<string, unknown>
  start: (
    progressCallback: (progress: number) => void,
    displayCallback: (svgList?: SVGSVGElement[], efficiency?: number, placed?: number, total?: number) => void,
  ) => boolean
  stop: () => void
}

type SvgNestWindow = Window & typeof globalThis & {
  SvgNest?: SvgNestApi
  SvgNestEvalPath?: string
}

type LayerNode = {
  id: string
  elementId: string
  name: string
  tag: string
  hidden: boolean
  children: LayerNode[]
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
  startCenter: Point
  selectedIds: string[]
  transformSnapshots: TransformSnapshot[]
  uniform: boolean
}

type TransformSnapshot = {
  id: string
  parentMatrix: DOMMatrix
  existingMatrix: DOMMatrix
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

type NestCandidate = {
  text: string
  efficiency: number
  placed: number
  total: number
  sheets: number
}

type SvgNestInput = {
  text: string
  width: number
  height: number
}

type NestPart = {
  element: Element
  box: DOMRect
}

type PackedNestPart = {
  part: NestPart
  sheet: number
  x: number
  y: number
}

const BED_WIDTH_MM = 300
const BED_HEIGHT_MM = 200
const CUT_RED = 'rgb(255, 0, 0)'
const ENGRAVE_BLUE = 'rgb(0, 0, 255)'
const GRAPHIC_SELECTOR =
  'path,line,polyline,polygon,rect,circle,ellipse,g,image,use,text'
const HIT_TEST_SELECTOR =
  'path,line,polyline,polygon,rect,circle,ellipse,image,use,text'
const NON_PART_SELECTOR = 'defs,style,title,desc,metadata,symbol,clipPath,mask,pattern'
const MAX_HISTORY = 80
const HIT_TOLERANCE_PX = 12
const VECTOR_STROKE_WIDTH = '1px'
const SVGNEST_BIN_ID = 'k40-svgnest-bin'
const SVGNEST_SCRIPTS = [
  'svgnest/util/pathsegpolyfill.js',
  'svgnest/util/matrix.js',
  'svgnest/util/domparser.js',
  'svgnest/util/clipper.js',
  'svgnest/util/parallel.js',
  'svgnest/util/geometryutil.js',
  'svgnest/util/placementworker.js',
  'svgnest/svgparser.js',
  'svgnest/svgnest.js',
]

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
    preserveAspectRatio: svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet',
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

function styleEntries(style: string) {
  return style
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':')
      if (separatorIndex === -1) {
        return { property: entry.toLowerCase(), value: '', raw: entry }
      }

      return {
        property: entry.slice(0, separatorIndex).trim().toLowerCase(),
        value: entry.slice(separatorIndex + 1).trim(),
        raw: entry,
      }
    })
}

function inlineStyleHasValue(element: Element, property: string, value: string) {
  const targetProperty = property.toLowerCase()
  const targetValue = value.toLowerCase()
  return styleEntries(element.getAttribute('style') ?? '').some((entry) => {
    const entryValue = entry.value.replace(/\s*!important\s*$/i, '').trim().toLowerCase()
    return entry.property === targetProperty && entryValue === targetValue
  })
}

function inlineStyleValue(element: Element, property: string) {
  const targetProperty = property.toLowerCase()
  const entry = styleEntries(element.getAttribute('style') ?? '')
    .find((styleEntry) => styleEntry.property === targetProperty)
  return entry?.value.replace(/\s*!important\s*$/i, '').trim() ?? null
}

function removeInlineStyleProperties(element: Element, properties: string[]) {
  const propertySet = new Set(properties.map((property) => property.toLowerCase()))
  const nextStyle = styleEntries(element.getAttribute('style') ?? '')
    .filter((entry) => !propertySet.has(entry.property))
    .map((entry) => entry.raw)
    .join(';')

  if (nextStyle) {
    element.setAttribute('style', nextStyle)
  } else {
    element.removeAttribute('style')
  }
}

function setInlineStyleProperty(element: Element, property: string, value: string) {
  const targetProperty = property.toLowerCase()
  const entries = styleEntries(element.getAttribute('style') ?? '')
    .filter((entry) => entry.property !== targetProperty)
    .map((entry) => entry.raw)

  entries.push(`${property}:${value}`)
  element.setAttribute('style', entries.join(';'))
}

function isElementHidden(element: Element) {
  return (
    element.getAttribute('display') === 'none' ||
    element.getAttribute('visibility') === 'hidden' ||
    inlineStyleHasValue(element, 'display', 'none') ||
    inlineStyleHasValue(element, 'visibility', 'hidden')
  )
}

function compactColor(value: string | null) {
  return value?.replace(/\s+/g, '').toLowerCase() ?? ''
}

function isK40VectorStroke(value: string | null) {
  const color = compactColor(value)
  return ['rgb(255,0,0)', '#ff0000', 'red', 'rgb(0,0,255)', '#0000ff', 'blue'].includes(color)
}

function setVectorStrokeStyle(element: Element) {
  element.setAttribute('stroke-width', VECTOR_STROKE_WIDTH)
  element.setAttribute('vector-effect', 'non-scaling-stroke')
  setInlineStyleProperty(element, 'stroke-width', `${VECTOR_STROKE_WIDTH} !important`)
  setInlineStyleProperty(element, 'vector-effect', 'non-scaling-stroke')
}

function setVectorStrokeColor(element: Element, color: string) {
  element.setAttribute('stroke', color)
  element.setAttribute('stroke-opacity', '1')
  removeInlineStyleProperties(element, ['stroke', 'stroke-opacity'])
  setInlineStyleProperty(element, 'stroke', `${color} !important`)
  setInlineStyleProperty(element, 'stroke-opacity', '1')
  setVectorStrokeStyle(element)
}

function keepVectorStrokeWidth(element: Element) {
  const stroke = element.getAttribute('stroke') ?? inlineStyleValue(element, 'stroke')
  if (isK40VectorStroke(stroke)) {
    setVectorStrokeStyle(element)
  }
}

function hasSheetGroups(svg: SVGSVGElement) {
  return svg.querySelector(':scope > g[data-k40-sheet]') !== null
}

function prependTransform(element: Element, transform: string) {
  const existingTransform = element.getAttribute('transform')
  element.setAttribute(
    'transform',
    existingTransform ? `${transform} ${existingTransform}` : transform,
  )
}

function frameArtworkOnBed(svg: SVGSVGElement, sourceViewBox: [number, number, number, number]) {
  const sourceWidthMm = parseLengthToMm(svg.getAttribute('width'), sourceViewBox[2])
  const sourceHeightMm = parseLengthToMm(svg.getAttribute('height'), sourceViewBox[3])
  const unitX = sourceWidthMm / sourceViewBox[2]
  const unitY = sourceHeightMm / sourceViewBox[3]
  const isAlreadyBedFramed =
    sourceViewBox[0] === 0 &&
    sourceViewBox[1] === 0 &&
    sourceViewBox[2] === BED_WIDTH_MM &&
    sourceViewBox[3] === BED_HEIGHT_MM &&
    sourceWidthMm === BED_WIDTH_MM &&
    sourceHeightMm === BED_HEIGHT_MM

  if (!isAlreadyBedFramed) {
    const toMillimetres = [
      `translate(${(-sourceViewBox[0] * unitX).toFixed(6)} ${(-sourceViewBox[1] * unitY).toFixed(6)})`,
      `scale(${unitX.toFixed(6)} ${unitY.toFixed(6)})`,
    ].join(' ')

    Array.from(svg.childNodes).forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return
      }

      const element = node as Element
      if (!element.matches(NON_PART_SELECTOR)) {
        prependTransform(element, toMillimetres)
      }
    })
  }

  svg.setAttribute('viewBox', `0 0 ${BED_WIDTH_MM} ${BED_HEIGHT_MM}`)
  svg.setAttribute('width', `${BED_WIDTH_MM}mm`)
  svg.setAttribute('height', `${BED_HEIGHT_MM}mm`)
}

function normaliseSvg(text: string) {
  const { doc, svg } = parseSvg(text)
  cleanSvgDocument(doc)

  if (!svg.getAttribute('xmlns')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }

  const viewBox = readViewBox(svg)
  if (hasSheetGroups(svg)) {
    svg.setAttribute('viewBox', viewBox.join(' '))
    svg.setAttribute('width', `${parseLengthToMm(svg.getAttribute('width'), viewBox[2]).toFixed(3)}mm`)
    svg.setAttribute('height', `${parseLengthToMm(svg.getAttribute('height'), viewBox[3]).toFixed(3)}mm`)
  } else {
    frameArtworkOnBed(svg, viewBox)
  }

  let nextId = 1
  const usedK40Ids = new Set<string>()

  function nextK40Id() {
    let candidate = `k40-${nextId}`
    nextId += 1

    while (usedK40Ids.has(candidate)) {
      candidate = `k40-${nextId}`
      nextId += 1
    }

    usedK40Ids.add(candidate)
    return candidate
  }

  svg.querySelectorAll(GRAPHIC_SELECTOR).forEach((element) => {
    const currentK40Id = element.getAttribute('data-k40-id')
    if (currentK40Id && !usedK40Ids.has(currentK40Id)) {
      usedK40Ids.add(currentK40Id)
    } else {
      element.setAttribute('data-k40-id', nextK40Id())
    }

    if (!element.getAttribute('data-k40-name')) {
      const id = element.getAttribute('id')
      element.setAttribute('data-k40-name', id || element.nodeName.toLowerCase())
    }

    keepVectorStrokeWidth(element)
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
    const hidden = isElementHidden(element)

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
    element.removeAttribute('visibility')
    element.removeAttribute('data-k40-hidden')
    removeInlineStyleProperties(element, ['display', 'visibility'])
  } else {
    element.setAttribute('display', 'none')
    element.setAttribute('data-k40-hidden', 'true')
    setInlineStyleProperty(element, 'display', 'none')
  }

  return serializeSvg(doc)
}

function makeAllElementsVisible(text: string) {
  const { doc, svg } = parseSvg(text)
  svg.querySelectorAll(GRAPHIC_SELECTOR).forEach((element) => {
    element.removeAttribute('display')
    element.removeAttribute('visibility')
    element.removeAttribute('data-k40-hidden')
    removeInlineStyleProperties(element, ['display', 'visibility'])
    setInlineStyleProperty(element, 'display', 'inline')
    setInlineStyleProperty(element, 'visibility', 'visible')
  })

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
        setVectorStrokeColor(child, color)
        child.setAttribute('fill', child.getAttribute('fill') === 'none' ? 'none' : child.getAttribute('fill') ?? 'none')
      }
    })
  } else if (element.nodeName.toLowerCase() !== 'image') {
    setVectorStrokeColor(element, color)
    if (!element.getAttribute('fill')) {
      element.setAttribute('fill', 'none')
    }
  }

  return serializeSvg(doc)
}

function applyElementTransforms(text: string, transforms: Map<string, string>) {
  const { doc } = parseSvg(text)

  transforms.forEach((transform, id) => {
    const element = doc.querySelector(`[data-k40-id="${CSS.escape(id)}"]`) as SVGElement | null
    if (element) {
      element.setAttribute('transform', transform)
    }
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

function pointInExpandedRect(rect: DOMRect, x: number, y: number, tolerance: number) {
  return (
    x >= rect.left - tolerance &&
    x <= rect.right + tolerance &&
    y >= rect.top - tolerance &&
    y <= rect.bottom + tolerance
  )
}

function hasPaintedFill(element: SVGElement) {
  const style = window.getComputedStyle(element)
  return style.fill !== 'none' && style.fillOpacity !== '0' && style.visibility !== 'hidden'
}

function geometryContainsPointNear(
  element: SVGGeometryElement,
  clientX: number,
  clientY: number,
  tolerance: number,
) {
  const svg = element.ownerSVGElement
  const matrix = element.getScreenCTM()
  if (!svg || !matrix) {
    return false
  }

  const inverse = matrix.inverse()
  const samples = [
    [0, 0],
    [-tolerance, 0],
    [tolerance, 0],
    [0, -tolerance],
    [0, tolerance],
    [-tolerance * 0.7, -tolerance * 0.7],
    [tolerance * 0.7, -tolerance * 0.7],
    [-tolerance * 0.7, tolerance * 0.7],
    [tolerance * 0.7, tolerance * 0.7],
  ]
  const shouldTestFill = hasPaintedFill(element)

  return samples.some(([dx, dy]) => {
    const point = svg.createSVGPoint()
    point.x = clientX + dx
    point.y = clientY + dy
    const localPoint = point.matrixTransform(inverse)
    return element.isPointInStroke(localPoint) || (shouldTestFill && element.isPointInFill(localPoint))
  })
}

function distanceToGeometryElement(element: SVGGeometryElement, clientX: number, clientY: number, tolerance: number) {
  if (geometryContainsPointNear(element, clientX, clientY, tolerance)) {
    return 0
  }

  const matrix = element.getScreenCTM()
  if (!matrix) {
    return Number.POSITIVE_INFINITY
  }

  try {
    const length = element.getTotalLength()
    if (!Number.isFinite(length) || length <= 0) {
      return Number.POSITIVE_INFINITY
    }

    const steps = Math.max(12, Math.min(96, Math.ceil(length / 3)))
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index <= steps; index += 1) {
      const localPoint = element.getPointAtLength((length * index) / steps)
      const screenPoint = localPoint.matrixTransform(matrix)
      bestDistance = Math.min(bestDistance, Math.hypot(screenPoint.x - clientX, screenPoint.y - clientY))
    }

    return bestDistance
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function findNearestClickableTarget(preview: HTMLDivElement | null, clientX: number, clientY: number) {
  const svg = preview?.querySelector('svg') as SVGSVGElement | null
  if (!svg) {
    return null
  }

  const tolerance = HIT_TOLERANCE_PX
  const candidates = Array.from(svg.querySelectorAll(HIT_TEST_SELECTOR)) as SVGElement[]
  let best: { element: SVGElement; distance: number; order: number } | null = null

  for (const [order, element] of candidates.entries()) {
    if (!element.getAttribute('data-k40-id')) {
      continue
    }

    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0 || !pointInExpandedRect(rect, clientX, clientY, tolerance * 1.6)) {
      continue
    }

    let distance = 0
    if (element instanceof SVGGeometryElement) {
      distance = distanceToGeometryElement(element, clientX, clientY, tolerance)
      if (distance > tolerance) {
        continue
      }
    }

    if (!best || distance < best.distance || (distance === best.distance && order > best.order)) {
      best = { element, distance, order }
    }
  }

  return best ? best.element : null
}

function getClickableTarget(
  target: EventTarget | null,
  preview: HTMLDivElement | null,
  clientX: number,
  clientY: number,
) {
  if (!(target instanceof Element)) {
    return findNearestClickableTarget(preview, clientX, clientY)
  }

  const directTarget = target.closest(HIT_TEST_SELECTOR) as SVGElement | null
  if (directTarget?.getAttribute('data-k40-id')) {
    return directTarget
  }

  return findNearestClickableTarget(preview, clientX, clientY)
}

function topLevelParts(svg: SVGSVGElement) {
  return Array.from(svg.children).filter((child) => {
    return !child.matches(NON_PART_SELECTOR)
  }) as SVGElement[]
}

function getElementBox(preview: HTMLDivElement, id: string) {
  const svg = preview.querySelector('svg') as SVGSVGElement | null
  const element = preview.querySelector(`[data-k40-id="${CSS.escape(id)}"]`) as SVGGraphicsElement | null
  if (!svg || !element) {
    return null
  }

  try {
    const box = element.getBBox()
    const svgMatrix = svg.getScreenCTM()
    const elementMatrix = element.getScreenCTM()
    if (!svgMatrix || !elementMatrix || box.width === 0 || box.height === 0) {
      return null
    }

    const matrix = svgMatrix.inverse().multiply(elementMatrix)
    const corners = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height },
    ].map((corner) => {
      const point = svg.createSVGPoint()
      point.x = corner.x
      point.y = corner.y
      return point.matrixTransform(matrix)
    })
    const minX = Math.min(...corners.map((corner) => corner.x))
    const minY = Math.min(...corners.map((corner) => corner.y))
    const maxX = Math.max(...corners.map((corner) => corner.x))
    const maxY = Math.max(...corners.map((corner) => corner.y))

    return new DOMRect(minX, minY, maxX - minX, maxY - minY)
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

function matrixToString(matrix: DOMMatrix) {
  return `matrix(${matrix.a.toFixed(8)} ${matrix.b.toFixed(8)} ${matrix.c.toFixed(8)} ${matrix.d.toFixed(8)} ${matrix.e.toFixed(4)} ${matrix.f.toFixed(4)})`
}

function rootMoveMatrix(dx: number, dy: number) {
  return new DOMMatrix().translate(dx, dy)
}

function rootRotateMatrix(degrees: number, center: Point) {
  return new DOMMatrix()
    .translate(center.x, center.y)
    .rotate(degrees)
    .translate(-center.x, -center.y)
}

function rootResizeMatrix(action: DragAction, box: SelectedBox, point: Point, uniform: boolean) {
  const anchor = getResizeAnchor(action, box)
  const preview = resizePreview(action, box, point, uniform)
  return new DOMMatrix()
    .translate(anchor.x, anchor.y)
    .scale(preview.scaleX, preview.scaleY)
    .translate(-anchor.x, -anchor.y)
}

function domMatrixFromSvgMatrix(matrix: DOMMatrix | SVGMatrix) {
  return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f])
}

function getElementTransformMatrix(element: SVGGraphicsElement) {
  const transform = element.transform.baseVal.consolidate()
  return transform ? domMatrixFromSvgMatrix(transform.matrix) : new DOMMatrix()
}

function getElementParentMatrixInRoot(svg: SVGSVGElement, element: SVGGraphicsElement, existingMatrix: DOMMatrix) {
  const svgScreenMatrix = svg.getScreenCTM()
  const elementScreenMatrix = element.getScreenCTM()
  if (!svgScreenMatrix || !elementScreenMatrix) {
    return null
  }

  try {
    const elementMatrixInRoot = domMatrixFromSvgMatrix(svgScreenMatrix)
      .inverse()
      .multiply(domMatrixFromSvgMatrix(elementScreenMatrix))

    return elementMatrixInRoot.multiply(existingMatrix.inverse())
  } catch {
    return null
  }
}

function getTransformSnapshots(preview: HTMLDivElement | null, ids: string[]) {
  const snapshots: TransformSnapshot[] = []
  const svg = preview?.querySelector('svg') as SVGSVGElement | null
  if (!svg) {
    return snapshots
  }

  ids.forEach((id) => {
    const element = svg.querySelector(`[data-k40-id="${CSS.escape(id)}"]`) as SVGGraphicsElement | null
    if (!element) {
      return
    }

    const existingMatrix = getElementTransformMatrix(element)
    const parentMatrix = getElementParentMatrixInRoot(svg, element, existingMatrix)
    if (!parentMatrix) {
      return
    }

    snapshots.push({ id, parentMatrix, existingMatrix })
  })

  return snapshots
}

function buildLocalTransformMap(snapshots: TransformSnapshot[], rootDelta: DOMMatrix) {
  const transforms = new Map<string, string>()

  snapshots.forEach(({ id, parentMatrix, existingMatrix }) => {
    try {
      const localDelta = parentMatrix.inverse().multiply(rootDelta).multiply(parentMatrix)
      const nextMatrix = localDelta.multiply(existingMatrix)
      transforms.set(id, matrixToString(nextMatrix))
    } catch {
      // Ignore non-invertible transforms so one unusual element does not break the whole drag.
    }
  })

  return transforms
}

function dragPreviewTransform(preview: DragPreview | null, box: SelectedBox) {
  if (!preview) {
    return undefined
  }

  if (preview.dx || preview.dy) {
    return `translate(${preview.dx} ${preview.dy})`
  }

  const origin = {
    x: box.x + (preview.originX / 100) * box.width,
    y: box.y + (preview.originY / 100) * box.height,
  }

  if (preview.rotation) {
    return `rotate(${preview.rotation} ${origin.x} ${origin.y})`
  }

  return `translate(${origin.x} ${origin.y}) scale(${preview.scaleX} ${preview.scaleY}) translate(${-origin.x} ${-origin.y})`
}

function unionBoxes(boxes: DOMRect[]) {
  const minX = Math.min(...boxes.map((box) => box.x))
  const minY = Math.min(...boxes.map((box) => box.y))
  const maxX = Math.max(...boxes.map((box) => box.x + box.width))
  const maxY = Math.max(...boxes.map((box) => box.y + box.height))
  return new DOMRect(minX, minY, maxX - minX, maxY - minY)
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

function k40FileName(fileName: string) {
  return fileName.replace(/\.svg$/i, '') + '-k40.svg'
}

async function collectSvgFiles(directoryHandle: LocalDirectoryHandle, basePath = directoryHandle.name) {
  const files: FileBrowserItem[] = []

  for await (const [, handle] of directoryHandle.entries()) {
    const path = `${basePath}/${handle.name}`
    if (handle.kind === 'directory') {
      files.push(...(await collectSvgFiles(handle, path)))
      continue
    }

    if (handle.name.toLowerCase().endsWith('.svg')) {
      files.push({
        id: path,
        name: handle.name,
        path,
        handle,
      })
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function ensureWritableFile(handle: LocalFileHandle) {
  const descriptor = { mode: 'readwrite' } as const
  if (handle.queryPermission && await handle.queryPermission(descriptor) === 'granted') {
    return true
  }

  if (handle.requestPermission) {
    return await handle.requestPermission(descriptor) === 'granted'
  }

  return true
}

async function writeSvgFile(handle: LocalFileHandle, text: string) {
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

let svgNestLoadPromise: Promise<SvgNestApi> | null = null

function loadScriptOnce(src: string) {
  const existing = document.querySelector(`script[data-k40-script="${CSS.escape(src)}"]`)
  if (existing) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${import.meta.env.BASE_URL}${src}`
    script.async = false
    script.dataset.k40Script = src
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true })
    document.head.appendChild(script)
  })
}

async function loadSvgNest() {
  ;(window as SvgNestWindow).SvgNestEvalPath = `${import.meta.env.BASE_URL}svgnest/util/eval.js`

  if (!svgNestLoadPromise) {
    svgNestLoadPromise = (async () => {
      for (const script of SVGNEST_SCRIPTS) {
        await loadScriptOnce(script)
      }

      const api = (window as SvgNestWindow).SvgNest
      if (!api) {
        throw new Error('SVGnest did not initialise.')
      }

      return api
    })()
  }

  return svgNestLoadPromise
}

function cloneVisibleSvgElement(element: SVGElement) {
  if (isElementHidden(element)) {
    return null
  }

  const clone = element.cloneNode(true) as SVGElement
  clone.querySelectorAll(GRAPHIC_SELECTOR).forEach((child) => {
    if (isElementHidden(child)) {
      child.remove()
    }
  })
  return clone
}

function estimateNestCanvas(sourceSvg: SVGSVGElement, partCount: number) {
  const viewBox = readViewBox(sourceSvg)
  const sourceWidth = parseLengthToMm(sourceSvg.getAttribute('width'), viewBox[2])
  const sourceHeight = parseLengthToMm(sourceSvg.getAttribute('height'), viewBox[3])
  const columns = Math.max(1, Math.ceil(Math.sqrt(partCount)))
  const rows = Math.max(1, Math.ceil(partCount / columns))

  return {
    width: Math.max(BED_WIDTH_MM, sourceWidth, BED_WIDTH_MM * columns),
    height: Math.max(BED_HEIGHT_MM, sourceHeight, BED_HEIGHT_MM * rows),
  }
}

function createSvgNestInput(text: string): SvgNestInput {
  const source = parseSvg(text)
  const output = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg')
  const svg = output.documentElement as unknown as SVGSVGElement
  const parts = topLevelParts(source.svg)
    .map((part) => cloneVisibleSvgElement(part))
    .filter((part): part is SVGElement => Boolean(part))
  const canvas = estimateNestCanvas(source.svg, parts.length)

  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', `${canvas.width}mm`)
  svg.setAttribute('height', `${canvas.height}mm`)
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`)

  source.svg.querySelectorAll('defs,style').forEach((node) => {
    svg.appendChild(output.importNode(node, true))
  })

  const bin = output.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bin.setAttribute('id', SVGNEST_BIN_ID)
  bin.setAttribute('x', '0')
  bin.setAttribute('y', '0')
  bin.setAttribute('width', String(canvas.width))
  bin.setAttribute('height', String(canvas.height))
  bin.setAttribute('fill', 'none')
  bin.setAttribute('stroke', 'none')
  svg.appendChild(bin)

  parts.forEach((clone) => {
    svg.appendChild(output.importNode(clone, true))
  })

  if (parts.length === 0) {
    throw new Error('No visible vector parts were found.')
  }

  return {
    text: serializeSvg(output),
    width: canvas.width,
    height: canvas.height,
  }
}

function isSvgNestBinElement(element: Element) {
  const classes = (element.getAttribute('class') ?? '').split(/\s+/)
  return element.getAttribute('id') === SVGNEST_BIN_ID || classes.includes('bin')
}

function boxFromSvgElement(svg: SVGSVGElement, element: SVGGraphicsElement) {
  const box = element.getBBox()
  const svgMatrix = svg.getScreenCTM()
  const elementMatrix = element.getScreenCTM()
  if (!svgMatrix || !elementMatrix || box.width === 0 || box.height === 0) {
    return null
  }

  const matrix = svgMatrix.inverse().multiply(elementMatrix)
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((corner) => {
    const point = svg.createSVGPoint()
    point.x = corner.x
    point.y = corner.y
    return point.matrixTransform(matrix)
  })

  const minX = Math.min(...corners.map((corner) => corner.x))
  const minY = Math.min(...corners.map((corner) => corner.y))
  const maxX = Math.max(...corners.map((corner) => corner.x))
  const maxY = Math.max(...corners.map((corner) => corner.y))
  return new DOMRect(minX, minY, maxX - minX, maxY - minY)
}

function measureNestParts(sheetSvg: SVGSVGElement, canvas: { width: number; height: number }) {
  const svg = sheetSvg.cloneNode(false) as SVGSVGElement
  const sourceParts: Element[] = []
  svg.setAttribute('width', `${canvas.width}px`)
  svg.setAttribute('height', `${canvas.height}px`)
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`)

  Array.from(sheetSvg.children).forEach((child) => {
    if (child.matches(NON_PART_SELECTOR) || isSvgNestBinElement(child)) {
      return
    }

    const measured = child.cloneNode(true) as Element
    measured.setAttribute('data-k40-measure-index', String(sourceParts.length))
    svg.appendChild(measured)
    sourceParts.push(child.cloneNode(true) as Element)
  })

  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-100000px'
  container.style.top = '0'
  container.style.width = `${canvas.width}px`
  container.style.height = `${canvas.height}px`
  container.style.overflow = 'hidden'
  container.style.visibility = 'hidden'
  container.appendChild(svg)
  document.body.appendChild(container)

  try {
    return Array.from(svg.children)
      .map((element) => {
        const index = Number(element.getAttribute('data-k40-measure-index'))
        const source = sourceParts[index]
        const box = boxFromSvgElement(svg, element as unknown as SVGGraphicsElement)
        if (!source || !box) {
          return null
        }

        return {
          element: source,
          box,
        }
      })
      .filter((part): part is NestPart => Boolean(part))
  } finally {
    container.remove()
  }
}

function expandedOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap: number,
) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  )
}

function sheetCandidatePositions(placed: PackedNestPart[], gap: number) {
  const xs = new Set([0])
  const ys = new Set([0])

  placed.forEach((item) => {
    xs.add(item.x)
    xs.add(item.x + item.part.box.width + gap)
    ys.add(item.y)
    ys.add(item.y + item.part.box.height + gap)
  })

  return Array.from(xs).flatMap((x) => Array.from(ys).map((y) => ({ x, y })))
}

function packNestParts(parts: NestPart[], gap: number) {
  const orderedParts = [...parts].sort((a, b) => {
    const areaA = a.box.width * a.box.height
    const areaB = b.box.width * b.box.height
    return areaB - areaA || Math.max(b.box.width, b.box.height) - Math.max(a.box.width, a.box.height)
  })
  const packed: PackedNestPart[] = []

  orderedParts.forEach((part) => {
    let best: { sheet: number; x: number; y: number; score: number } | null = null
    const currentSheetCount = Math.max(1, Math.max(-1, ...packed.map((item) => item.sheet)) + 1)

    for (let sheet = 0; sheet <= currentSheetCount; sheet += 1) {
      const sheetParts = packed.filter((item) => item.sheet === sheet)
      const candidates = sheetParts.length === 0 ? [{ x: 0, y: 0 }] : sheetCandidatePositions(sheetParts, gap)

      candidates.forEach(({ x, y }) => {
        if (
          x + part.box.width > BED_WIDTH_MM ||
          y + part.box.height > BED_HEIGHT_MM ||
          sheetParts.some((item) => expandedOverlap(
            { x, y, width: part.box.width, height: part.box.height },
            { x: item.x, y: item.y, width: item.part.box.width, height: item.part.box.height },
            gap,
          ))
        ) {
          return
        }

        const usedWidth = Math.max(x + part.box.width, ...sheetParts.map((item) => item.x + item.part.box.width))
        const usedHeight = Math.max(y + part.box.height, ...sheetParts.map((item) => item.y + item.part.box.height))
        const fullness = Math.max(usedWidth / BED_WIDTH_MM, usedHeight / BED_HEIGHT_MM)
        const score = sheet * 1_000_000 + fullness * 10_000 + usedHeight * 10 + y + x * 0.01

        if (!best || score < best.score) {
          best = { sheet, x, y, score }
        }
      })
    }

    const bestPlacement = best as { sheet: number; x: number; y: number; score: number } | null
    packed.push(bestPlacement
      ? { part, sheet: bestPlacement.sheet, x: bestPlacement.x, y: bestPlacement.y }
      : { part, sheet: currentSheetCount, x: 0, y: 0 })
  })

  return packed
}

function combineSvgNestSheets(
  svgList: SVGSVGElement[],
  sourceText: string,
  canvas: SvgNestInput,
  gap: number,
) {
  const source = parseSvg(sourceText)
  const packedParts = packNestParts(
    svgList.flatMap((sheetSvg) => measureNestParts(sheetSvg, canvas)),
    Math.max(0, gap),
  )
  const output = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg')
  const svg = output.documentElement as unknown as SVGSVGElement
  const sheetCount = Math.max(1, Math.max(-1, ...packedParts.map((item) => item.sheet)) + 1)

  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', `${BED_WIDTH_MM}mm`)
  svg.setAttribute('height', `${BED_HEIGHT_MM}mm`)
  svg.setAttribute('viewBox', `0 0 ${BED_WIDTH_MM} ${BED_HEIGHT_MM}`)

  source.svg.querySelectorAll('defs,style').forEach((node) => {
    svg.appendChild(output.importNode(node, true))
  })

  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
    const group = output.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('id', `sheet-${sheetIndex + 1}`)
    group.setAttribute('data-k40-id', `sheet-${sheetIndex + 1}`)
    group.setAttribute('data-k40-name', `sheet-${sheetIndex + 1}`)
    group.setAttribute('data-k40-sheet', String(sheetIndex + 1))
    if (sheetIndex > 0) {
      group.setAttribute('display', 'none')
      group.setAttribute('data-k40-hidden', 'true')
      setInlineStyleProperty(group, 'display', 'none')
    }

    packedParts
      .filter((item) => item.sheet === sheetIndex)
      .forEach((item) => {
        const imported = output.importNode(item.part.element, true) as Element
        prependTransform(
          imported,
          `translate(${(item.x - item.part.box.x).toFixed(4)} ${(item.y - item.part.box.y).toFixed(4)})`,
        )
        group.appendChild(imported)
      })

    svg.appendChild(group)
  }

  return {
    text: serializeSvg(output),
    sheets: sheetCount,
  }
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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())

  function toggleCollapsed(id: string) {
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function renderNode(node: LayerNode, depth: number) {
    const isSelected = selectedIds.includes(node.id)
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedIds.has(node.id)

    return (
      <li className="layer-item" key={`${node.id}-${node.name}-${node.hidden}`}>
        <div
          className={`layer-row ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${depth * 14}px` }}
          onClick={(event) => onSelect(node.id, event.shiftKey || event.metaKey)}
        >
          <button
            type="button"
            className={`icon-button collapse-toggle ${isCollapsed ? 'collapsed' : ''}`}
            disabled={!hasChildren}
            onClick={(event) => {
              event.stopPropagation()
              toggleCollapsed(node.id)
            }}
            aria-label={isCollapsed ? `Open ${node.name}` : `Collapse ${node.name}`}
            title={isCollapsed ? 'Open group' : 'Collapse group'}
          >
            <span aria-hidden="true" />
          </button>
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
            <span className="eye-icon" aria-hidden="true" />
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
        {hasChildren && !isCollapsed ? (
          <ul className="layer-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  return <ul className="layer-tree">{nodes.map((node) => renderNode(node, 0))}</ul>
}

function FileBrowser({
  files,
  activeFileId,
  isDirty,
  folderName,
  onOpenFolder,
  onSelectFile,
}: {
  files: FileBrowserItem[]
  activeFileId: string | null
  isDirty: boolean
  folderName: string
  onOpenFolder: () => void
  onSelectFile: (file: FileBrowserItem) => void
}) {
  return (
    <div className="file-browser">
      <div className="file-browser-actions">
        <button type="button" onClick={onOpenFolder}>
          Open folder
        </button>
        {folderName ? <span>{folderName}</span> : null}
      </div>
      {files.length > 0 ? (
        <ul className="file-tree">
          {files.map((file) => {
            const isActive = file.id === activeFileId
            return (
              <li key={file.id}>
                <button
                  type="button"
                  className={`file-row ${isActive ? 'active' : ''}`}
                  onClick={() => onSelectFile(file)}
                >
                  <span className="file-title">
                    {file.name}
                    {isActive && isDirty ? <strong>*</strong> : null}
                  </span>
                  <span className="file-path">({file.path})</span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="empty-state">Open a folder to browse SVG documents.</p>
      )}
    </div>
  )
}

function App() {
  const [history, setHistory] = useState<HistoryState>(() => ({
    past: [],
    present: normaliseSvg(sampleSvg),
    future: [],
  }))
  const [savedText, setSavedText] = useState(() => normaliseSvg(sampleSvg))
  const [fileName, setFileName] = useState('k40-sample.svg')
  const [activeFileHandle, setActiveFileHandle] = useState<LocalFileHandle | null>(null)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderFiles, setFolderFiles] = useState<FileBrowserItem[]>([])
  const [pendingFile, setPendingFile] = useState<FileBrowserItem | null>(null)
  const [isFileDrawerOpen, setIsFileDrawerOpen] = useState(false)
  const [toolMode, setToolMode] = useState<ToolMode>('select')
  const [selectedPoints, setSelectedPoints] = useState<Point[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectionBox, setSelectionBox] = useState<SelectedBox | null>(null)
  const [hoverSelectable, setHoverSelectable] = useState(false)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [targetDistance, setTargetDistance] = useState('')
  const [gapMm, setGapMm] = useState(2)
  const [status, setStatus] = useState('Sample loaded')
  const [nestOpen, setNestOpen] = useState(false)
  const [nestRunning, setNestRunning] = useState(false)
  const [nestStatus, setNestStatus] = useState('')
  const [nestProgress, setNestProgress] = useState(0)
  const [nestCandidate, setNestCandidate] = useState<NestCandidate | null>(null)
  const [nestMakeAllVisible, setNestMakeAllVisible] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const svgNestRef = useRef<SvgNestApi | null>(null)
  const nestRunIdRef = useRef(0)
  const svgText = history.present
  const isDirty = svgText !== savedText

  const svgInfo = useMemo(() => getSvgInfo(svgText), [svgText])
  const sheetCount = useMemo(() => getSheetCount(svgText), [svgText])
  const layers = useMemo(() => getLayerTree(svgText), [svgText])
  const measuredDistance = selectedPoints.length === 2
    ? distanceInMm(selectedPoints[0], selectedPoints[1], svgInfo)
    : null
  const overlayControlRadius = Math.max(1.4, Math.min(svgInfo.viewBox[2], svgInfo.viewBox[3]) * 0.012)
  const overlayRotateOffset = selectionBox
    ? Math.max(overlayControlRadius * 4, Math.min(selectionBox.width, selectionBox.height) * 0.08)
    : overlayControlRadius * 4
  const bedUsage = Math.min(
    100,
    ((svgInfo.widthMm * svgInfo.heightMm) / (BED_WIDTH_MM * BED_HEIGHT_MM)) * 100,
  )
  const previewAspect = svgInfo.viewBox[2] / svgInfo.viewBox[3]

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSelectionBox(getSelectionBox(previewRef.current, selectedIds))
    })

    return () => cancelAnimationFrame(frame)
  }, [selectedIds, svgText])

  useEffect(() => {
    return () => {
      svgNestRef.current?.stop()
    }
  }, [])

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

  const undo = useCallback(() => {
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
  }, [])

  const redo = useCallback(() => {
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
  }, [])

  function openSvgText(text: string, nextFileName: string, nextStatus: string, fileHandle: LocalFileHandle | null, fileId: string | null) {
    const normalised = normaliseSvg(text)
    commitSvg(normalised, nextStatus, true)
    setSavedText(normalised)
    setFileName(nextFileName)
    setActiveFileHandle(fileHandle)
    setActiveFileId(fileId)
    setSelectedIds([])
    setPendingFile(null)
  }

  async function openFolder() {
    const picker = (window as FileSystemWindow).showDirectoryPicker
    if (!picker) {
      setStatus('Folder browsing needs a browser with File System Access API support.')
      return
    }

    try {
      const directory = await picker()
      const files = await collectSvgFiles(directory)
      setFolderName(directory.name)
      setFolderFiles(files)
      setIsFileDrawerOpen(true)
      setStatus(files.length > 0 ? `${files.length} SVG document${files.length === 1 ? '' : 's'} found` : 'No SVG documents found')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
      setStatus(error instanceof Error ? error.message : 'Could not open that folder.')
    }
  }

  async function openBrowserFile(file: FileBrowserItem) {
    try {
      const source = await file.handle.getFile()
      openSvgText(await source.text(), file.name, `${file.name} opened`, file.handle, file.id)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open that SVG.')
    }
  }

  function requestOpenBrowserFile(file: FileBrowserItem) {
    if (file.id === activeFileId) {
      setStatus(isDirty ? 'Current document has unsaved changes' : 'Document already open')
      return
    }

    if (isDirty) {
      setPendingFile(file)
      return
    }

    void openBrowserFile(file)
  }

  const saveAsK40File = useCallback(async () => {
    const nextFileName = k40FileName(fileName)
    const picker = (window as FileSystemWindow).showSaveFilePicker

    if (!picker) {
      downloadSvg(svgText, nextFileName)
      setStatus('Downloaded K40 SVG; browser did not grant write access.')
      setSavedText(svgText)
      return true
    }

    try {
      const handle = await picker({
        suggestedName: nextFileName,
        types: [{
          description: 'SVG document',
          accept: { 'image/svg+xml': ['.svg'] },
        }],
      })
      if (!await ensureWritableFile(handle)) {
        setStatus('Write permission was not granted.')
        return false
      }

      await writeSvgFile(handle, svgText)
      setActiveFileHandle(handle)
      setActiveFileId(null)
      setFileName(handle.name)
      setSavedText(svgText)
      setStatus(`${handle.name} saved`)
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false
      }
      setStatus(error instanceof Error ? error.message : 'Could not save that SVG.')
      return false
    }
  }, [fileName, svgText])

  const saveCurrentFile = useCallback(async () => {
    if (!activeFileHandle) {
      return saveAsK40File()
    }

    try {
      if (!await ensureWritableFile(activeFileHandle)) {
        setStatus('Write permission was not granted.')
        return false
      }

      await writeSvgFile(activeFileHandle, svgText)
      setSavedText(svgText)
      setStatus(`${fileName} saved`)
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save that SVG.')
      return false
    }
  }, [activeFileHandle, fileName, saveAsK40File, svgText])

  async function savePendingThenOpen() {
    if (!pendingFile) {
      return
    }

    if (await saveCurrentFile()) {
      await openBrowserFile(pendingFile)
    }
  }

  async function discardPendingAndOpen() {
    if (!pendingFile) {
      return
    }

    await openBrowserFile(pendingFile)
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
        openSvgText(text, file.name, `${file.name} opened`, null, null)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open that SVG.')
      }
    })
    reader.readAsText(file)
  }

  function handlePreviewClick(event: MouseEvent<HTMLDivElement>) {
    if (toolMode === 'select') {
      const target = getClickableTarget(event.target, previewRef.current, event.clientX, event.clientY)
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

    const target = getClickableTarget(event.target, previewRef.current, event.clientX, event.clientY)
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

    const target = getClickableTarget(event.target, previewRef.current, event.clientX, event.clientY)
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

  function beginSelectionDrag(event: PointerEvent<Element>, action: DragAction) {
    if (!selectionBox || selectedIds.length === 0 || toolMode !== 'select') {
      return
    }

    const startPoint = getSvgPoint(event.clientX, event.clientY, previewRef.current)
    if (!startPoint) {
      return
    }

    const transformSnapshots = getTransformSnapshots(previewRef.current, selectedIds)
    if (transformSnapshots.length === 0) {
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
      startCenter: {
        x: selectionBox.x + selectionBox.width / 2,
        y: selectionBox.y + selectionBox.height / 2,
      },
      selectedIds: [...selectedIds],
      transformSnapshots,
      uniform: event.shiftKey,
    }
    setStatus(action === 'move' ? 'Dragging selection' : 'Editing selection')
  }

  function updateSelectionDrag(event: PointerEvent<Element>) {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      if (
        event.currentTarget === previewRef.current &&
        (toolMode === 'select' || toolMode === 'cut' || toolMode === 'engrave')
      ) {
        setHoverSelectable(Boolean(getClickableTarget(event.target, previewRef.current, event.clientX, event.clientY)))
      }
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
      const startAngle = pointAngle(dragState.startCenter, dragState.startPoint)
      const currentAngle = pointAngle(dragState.startCenter, currentPoint)
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

  function endSelectionDrag(event: PointerEvent<Element>) {
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
      const transforms = buildLocalTransformMap(
        dragState.transformSnapshots,
        rootMoveMatrix(dx, dy),
      )
      updateSvg(
        (current) => applyElementTransforms(current, transforms),
        'Selection moved',
      )
      return
    }

    if (dragState.action === 'rotate') {
      const degrees = toDegrees(
        pointAngle(dragState.startCenter, endPoint) - pointAngle(dragState.startCenter, dragState.startPoint),
      )
      const transforms = buildLocalTransformMap(
        dragState.transformSnapshots,
        rootRotateMatrix(degrees, dragState.startCenter),
      )
      updateSvg(
        (current) => applyElementTransforms(current, transforms),
        'Selection rotated',
      )
      return
    }

    const transforms = buildLocalTransformMap(
      dragState.transformSnapshots,
      rootResizeMatrix(dragState.action, dragState.startBox, endPoint, dragState.uniform),
    )
    updateSvg(
      (current) => applyElementTransforms(current, transforms),
      dragState.uniform ? 'Selection scaled' : 'Selection resized',
    )
  }

  function stopNestWorkflow(nextStatus = 'SVGnest search stopped') {
    nestRunIdRef.current += 1
    svgNestRef.current?.stop()
    setNestRunning(false)
    setNestStatus(nextStatus)
  }

  function closeNestWorkflow() {
    stopNestWorkflow('SVGnest search cancelled')
    setNestOpen(false)
  }

  async function openNestWorkflow() {
    const runId = nestRunIdRef.current + 1
    nestRunIdRef.current = runId
    setNestOpen(true)
    setNestRunning(false)
    setNestCandidate(null)
    setNestProgress(0)
    setNestStatus('Loading SVGnest...')

    try {
      const api = await loadSvgNest()
      if (runId !== nestRunIdRef.current) {
        return
      }

      svgNestRef.current = api
      api.stop()
      api.config({
        spacing: Math.max(0, gapMm),
        rotations: 8,
        populationSize: 12,
        mutationRate: 10,
        useHoles: true,
        exploreConcave: false,
        curveTolerance: 0.3,
      })

      const sourceText = nestMakeAllVisible ? makeAllElementsVisible(svgText) : svgText
      const nestInput = createSvgNestInput(sourceText)
      const parsedSvg = api.parsesvg(nestInput.text)
      const bin = parsedSvg.querySelector(`#${SVGNEST_BIN_ID}`)
      if (!bin) {
        throw new Error('Could not prepare the K40 bed for SVGnest.')
      }

      api.setbin(bin)
      setNestRunning(true)
      setNestStatus('Searching for a compact SVGnest layout...')

      const started = api.start(
        (progress) => {
          if (runId === nestRunIdRef.current) {
            const percent = progress <= 1 ? progress * 100 : progress
            setNestProgress(Math.max(0, Math.min(100, percent)))
          }
        },
        (svgList, efficiency = 0, placed = 0, total = 0) => {
          if (runId !== nestRunIdRef.current || !svgList || svgList.length === 0) {
            return
          }

          const result = combineSvgNestSheets(svgList, sourceText, nestInput, gapMm)
          setNestCandidate({
            text: result.text,
            efficiency,
            placed,
            total,
            sheets: result.sheets,
          })
          setNestStatus(
            `Best so far: ${placed}/${total} parts on ${result.sheets} sheet${result.sheets === 1 ? '' : 's'} (${Math.round(efficiency * 100)}% bed use)`,
          )
        },
      )

      if (started === false) {
        throw new Error('SVGnest could not start. Check that the document contains closed vector outlines.')
      }
    } catch (error) {
      setNestRunning(false)
      setNestStatus(error instanceof Error ? error.message : 'SVGnest could not prepare this document.')
      setStatus(error instanceof Error ? error.message : 'SVGnest failed')
    }
  }

  function acceptNestCandidate() {
    if (!nestCandidate) {
      return
    }

    stopNestWorkflow('SVGnest layout accepted')
    commitSvg(
      normaliseSvg(nestCandidate.text),
      `${nestCandidate.placed}/${nestCandidate.total} parts nested into ${nestCandidate.sheets} sheet${nestCandidate.sheets === 1 ? '' : 's'}`,
    )
    setSelectedIds([])
    setNestOpen(false)
  }

  function resetSample() {
    const normalised = normaliseSvg(sampleSvg)
    commitSvg(normalised, 'Sample loaded', true)
    setSavedText(normalised)
    setFileName('k40-sample.svg')
    setActiveFileHandle(null)
    setActiveFileId(null)
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

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const commandKey = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (!commandKey) {
        return
      }

      if (key === 's') {
        event.preventDefault()
        if (event.shiftKey) {
          void saveAsK40File()
        } else {
          void saveCurrentFile()
        }
        return
      }

      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          redo()
        } else {
          undo()
        }
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [redo, saveAsK40File, saveCurrentFile, undo])

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
          <button type="button" onClick={() => void saveCurrentFile()} disabled={!isDirty && Boolean(activeFileHandle)}>
            Save
          </button>
          <button type="button" onClick={() => void saveAsK40File()}>
            Save as K40
          </button>
          <label className="file-button">
            Open SVG
            <input type="file" accept=".svg,image/svg+xml" onChange={handleFileChange} />
          </label>
          <button type="button" onClick={() => void openFolder()}>
            Open folder
          </button>
          <button type="button" onClick={() => downloadSvg(svgText, k40FileName(fileName))}>
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
              <strong>{fileName}{isDirty ? ' *' : ''}</strong>
              <span>{sheetCount} sheet{sheetCount === 1 ? '' : 's'} · {status}</span>
            </div>
            <button type="button" onClick={resetSample}>
              Load sample
            </button>
          </div>
          <div
            className="bed-frame"
            style={{
              aspectRatio: `${svgInfo.viewBox[2]} / ${svgInfo.viewBox[3]}`,
              width: `min(calc(100% - 64px), 900px, calc((100vh - 148px) * ${previewAspect}))`,
            }}
          >
            <div className="bed-ruler x">300 mm</div>
            <div className="bed-ruler y">200 mm</div>
            <div
              ref={previewRef}
              className={`svg-preview mode-${toolMode} ${hoverSelectable ? 'can-select' : ''}`}
              onClick={handlePreviewClick}
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={updateSelectionDrag}
              onPointerLeave={() => setHoverSelectable(false)}
              onPointerUp={endSelectionDrag}
              onPointerCancel={endSelectionDrag}
              dangerouslySetInnerHTML={{ __html: svgText }}
            />
            <svg
              className="preview-overlay"
              viewBox={svgInfo.viewBox.join(' ')}
              preserveAspectRatio={svgInfo.preserveAspectRatio}
            >
              {toolMode === 'select' && selectionBox ? (
                <g
                  className="selection-box"
                  transform={dragPreviewTransform(dragPreview, selectionBox)}
                  onPointerDown={(event) => beginSelectionDrag(event, 'move')}
                  onPointerMove={updateSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                >
                  <rect
                    className="selection-rect"
                    x={selectionBox.x}
                    y={selectionBox.y}
                    width={selectionBox.width}
                    height={selectionBox.height}
                  />
                  <circle
                    className="resize-handle nw"
                    cx={selectionBox.x}
                    cy={selectionBox.y}
                    r={overlayControlRadius}
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-nw')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <circle
                    className="resize-handle ne"
                    cx={selectionBox.x + selectionBox.width}
                    cy={selectionBox.y}
                    r={overlayControlRadius}
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-ne')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <circle
                    className="resize-handle sw"
                    cx={selectionBox.x}
                    cy={selectionBox.y + selectionBox.height}
                    r={overlayControlRadius}
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-sw')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <circle
                    className="resize-handle se"
                    cx={selectionBox.x + selectionBox.width}
                    cy={selectionBox.y + selectionBox.height}
                    r={overlayControlRadius}
                    onPointerDown={(event) => beginSelectionDrag(event, 'resize-se')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                  <line
                    className="rotate-stem"
                    x1={selectionBox.x + selectionBox.width}
                    y1={selectionBox.y + selectionBox.height}
                    x2={selectionBox.x + selectionBox.width + overlayRotateOffset}
                    y2={selectionBox.y + selectionBox.height + overlayRotateOffset}
                  />
                  <circle
                    className="rotate-handle"
                    cx={selectionBox.x + selectionBox.width + overlayRotateOffset}
                    cy={selectionBox.y + selectionBox.height + overlayRotateOffset}
                    r={overlayControlRadius * 1.15}
                    onPointerDown={(event) => beginSelectionDrag(event, 'rotate')}
                    onPointerMove={updateSelectionDrag}
                    onPointerUp={endSelectionDrag}
                    onPointerCancel={endSelectionDrag}
                  />
                </g>
              ) : null}
              {selectedPoints.map((point, index) => (
                <g
                  className="measurement-target"
                  key={`${point.x}-${point.y}-${index}`}
                >
                  <line
                    x1={point.x - overlayControlRadius * 1.5}
                    y1={point.y}
                    x2={point.x + overlayControlRadius * 1.5}
                    y2={point.y}
                  />
                  <line
                    x1={point.x}
                    y1={point.y - overlayControlRadius * 1.5}
                    x2={point.x}
                    y2={point.y + overlayControlRadius * 1.5}
                  />
                  <circle cx={point.x} cy={point.y} r={overlayControlRadius} />
                  <text
                    x={point.x}
                    y={point.y + overlayControlRadius * 0.28}
                    fontSize={overlayControlRadius * 1.05}
                  >
                    {index + 1}
                  </text>
                </g>
              ))}
            </svg>
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
            <label className="check-field">
              <input
                type="checkbox"
                checked={nestMakeAllVisible}
                onChange={(event) => setNestMakeAllVisible(event.target.checked)}
              />
              <span>Make all elements visible</span>
            </label>
            <button type="button" className="primary-action" onClick={() => void openNestWorkflow()}>
              Auto-position elements
            </button>
          </div>

          <div className="panel-section">
            <h2>Export</h2>
            <button type="button" className="primary-action" onClick={() => downloadSvg(svgText, k40FileName(fileName))}>
              Download K40 SVG
            </button>
          </div>
        </aside>
      </section>
      {isFileDrawerOpen ? (
        <aside className="file-drawer" aria-label="SVG files">
          <div className="file-drawer-header">
            <h2>Files</h2>
            <button type="button" className="icon-button" onClick={() => setIsFileDrawerOpen(false)}>
              Hide
            </button>
          </div>
          <FileBrowser
            files={folderFiles}
            activeFileId={activeFileId}
            isDirty={isDirty}
            folderName={folderName}
            onOpenFolder={() => void openFolder()}
            onSelectFile={requestOpenBrowserFile}
          />
        </aside>
      ) : (
        <button
          type="button"
          className="file-drawer-tab"
          onClick={() => setIsFileDrawerOpen(true)}
          title="Show files"
        >
          Files
        </button>
      )}
      {nestOpen ? (
        <div className="modal-backdrop nest-backdrop" role="presentation">
          <div
            className="nest-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nest-dialog-title"
          >
            <header className="nest-header">
              <div>
                <h2 id="nest-dialog-title">SVGnest auto-positioning</h2>
                <p>{nestStatus}</p>
              </div>
              <button type="button" className="icon-button" onClick={closeNestWorkflow}>
                Close
              </button>
            </header>
            <div className="nest-progress" aria-label={`SVGnest search progress ${nestProgress.toFixed(0)} percent`}>
              <span style={{ width: `${nestProgress}%` }} />
            </div>
            <div className="nest-preview">
              {nestCandidate ? (
                <div dangerouslySetInnerHTML={{ __html: nestCandidate.text }} />
              ) : (
                <div className="nest-empty">Waiting for the first layout...</div>
              )}
            </div>
            <footer className="nest-actions">
              <button
                type="button"
                onClick={() => {
                  if (nestRunning) {
                    stopNestWorkflow()
                  } else {
                    void openNestWorkflow()
                  }
                }}
              >
                {nestRunning ? 'Stop search' : 'Restart search'}
              </button>
              <button type="button" onClick={closeNestWorkflow}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={acceptNestCandidate}
                disabled={!nestCandidate}
              >
                Accept layout
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      {pendingFile ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-dialog-title"
          >
            <h2 id="unsaved-dialog-title">Unsaved changes</h2>
            <p>
              Save changes to {fileName} before opening {pendingFile.name}?
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => void savePendingThenOpen()}>
                Save and open
              </button>
              <button type="button" onClick={() => void discardPendingAndOpen()}>
                Discard and open
              </button>
              <button type="button" onClick={() => setPendingFile(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
