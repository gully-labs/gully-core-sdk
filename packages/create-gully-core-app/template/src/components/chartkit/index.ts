// SPDX-License-Identifier: MIT
/* The shared chart kit (2026-10-11). See README.md in this folder for the API and the migration map. */
import './chartkit.css'

export { ChartKitProvider, useReveal, useSize, type MotionMode } from './runtime'
export {
  ChartCard,
  ChartEmpty,
  ChartError,
  ChartSkeleton,
  ChartSoon,
  ChartTable,
  Legend,
  useChartView,
  type ChartCardProps,
  type ChartState,
  type ChartView,
  type LegendItem,
  type RangeChips,
  type TableData,
} from './frame'
export { AreaLine, areaLineGeometry, areaLineTable, type AreaLineProps, type XYPoint, type XYSeries } from './AreaLine'
export { Bars, DivergingBars, barsTable, divergingTable, roundedBar, type BarDatum, type BarsProps, type DivergingBarsProps, type DivergingDatum } from './Bars'
export { Ring, ringGeometry, ringTable, type RingProps, type RingSegment } from './Ring'
export { StepCurve, stepCurveTable, unlockedAt, type Step, type StepCurveProps } from './StepCurve'
export { RangeBand, rangeBandTable, rangeStatus, type RangeBandProps, type RangeStatus } from './RangeBand'
export { BarList, barListTable, type BarListProps, type BarListRow } from './BarList'
export { ChartGrid, KpiTile, Sparkline, sparkPath, type KpiTileProps, type SparklineProps } from './Kpi'
export { DOWN_COLOR, SERIES_COLORS, UP_COLOR, compactTick, notEnough, seriesColor, sharePct, signedPct, stepIndex, timeTick } from './core'
