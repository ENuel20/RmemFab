import { describe, it } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

describe('Latency Terminology, Percentile Binning & Queueing Clarity Parity', () => {
  it('PolicyComparisonView uses clear memory read latency terminology and tooltips', () => {
    const comparisonPath = path.resolve(__dirname, 'PolicyComparisonView.tsx')
    const content = fs.readFileSync(comparisonPath, 'utf-8')

    assert.ok(
      content.includes('Memory Read Latency Comparison (Lower is Better &darr;)'),
      'Must contain specific page-level read latency chart title'
    )
    assert.ok(
      content.includes('Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration.'),
      'Must contain explicit subtitle distinguishing page access from request duration'
    )
    assert.ok(
      content.includes('Memory Read Latency (p50)'),
      'Must label p50 row as Memory Read Latency (p50)'
    )
    assert.ok(
      content.includes('Memory Read Latency (p95)'),
      'Must label p95 row as Memory Read Latency (p95)'
    )
    assert.ok(
      content.includes('Memory Read Latency (p99)'),
      'Must label p99 row as Memory Read Latency (p99)'
    )
    assert.ok(
      content.includes('Mean Memory Read Latency'),
      'Must label mean row as Mean Memory Read Latency'
    )
    assert.ok(
      content.includes('title="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration."'),
      'Must contain standardized percentile explanation tooltip'
    )
    assert.ok(
      content.includes('title="Mean includes queueing delays, so a small number of heavily delayed accesses can raise the average above p99."'),
      'Must explain why arithmetic mean can exceed p99 due to queueing delays'
    )
  })

  it('OverviewView uses precise memory read latency terminology on KPI cards, charts and table headers', () => {
    const overviewPath = path.resolve(__dirname, '../overview/OverviewView.tsx')
    const content = fs.readFileSync(overviewPath, 'utf-8')

    assert.ok(
      content.includes('title="Memory Read Latency (p50)"'),
      'Overview KPI card must specify Memory Read Latency (p50)'
    )
    assert.ok(
      content.includes('tooltip="Measures the time to access a memory page during simulation. These percentiles represent page-level memory read latency, not end-to-end request duration."'),
      'Overview KPI card must provide contextual tooltip'
    )
    assert.ok(
      content.includes('Memory Read Latency (ns)'),
      'Overview chart metric toggle must specify Memory Read Latency (ns)'
    )
    assert.ok(
      content.includes('Page-level memory read latency across percentiles. Identical percentiles reflect high local tier hit rates and histogram bin resolution.'),
      'Overview Latency Distribution card must explain percentile identity'
    )
    assert.ok(
      content.includes('Memory Read (p50)'),
      'Overview table header must specify Memory Read (p50)'
    )
    assert.ok(
      content.includes('Memory Read (p99)'),
      'Overview table header must specify Memory Read (p99)'
    )
    assert.ok(
      content.includes('Local DRAM Page-Read Baseline (~5.3 µs)'),
      'Overview progression visualizer must display accurate Local DRAM page-read baseline (~5.3 µs)'
    )
    assert.ok(
      content.includes('Remote CXL Page-Read (~44.2 µs)'),
      'Overview progression visualizer must display accurate Remote CXL page-read reference (~44.2 µs)'
    )
    assert.ok(
      !content.includes('Local DRAM Floor (~100 ns)'),
      'Overview must not contain misleading 100 ns floor annotation'
    )
  })

  it('SimulationRunsView clarifies memory read latency in sort options, table headers, and inspector', () => {
    const runsPath = path.resolve(__dirname, '../runs/SimulationRunsView.tsx')
    const content = fs.readFileSync(runsPath, 'utf-8')

    assert.ok(
      content.includes('<span>Memory Read (p50)</span>'),
      'Simulation runs sort dropdown must specify Memory Read (p50)'
    )
    assert.ok(
      content.includes('Memory Read (p50)'),
      'Simulation runs table header must specify Memory Read (p50)'
    )
    assert.ok(
      content.includes('MEMORY READ LATENCY (p50)'),
      'Simulation runs inspector card must specify MEMORY READ LATENCY (p50)'
    )
    assert.ok(
      content.includes('TAIL READ LATENCY (p99)'),
      'Simulation runs inspector card must specify TAIL READ LATENCY (p99)'
    )
    assert.ok(
      content.includes('Mean includes queueing delays, so a small number of heavily delayed accesses can raise the average above p99.'),
      'Simulation runs inspector must clarify mean latency vs p99'
    )
  })

  it('KpiCard component accepts optional tooltip prop and sets title attribute', () => {
    const kpiCardPath = path.resolve(__dirname, '../common/KpiCard.tsx')
    const content = fs.readFileSync(kpiCardPath, 'utf-8')

    assert.ok(
      content.includes('tooltip?: string'),
      'KpiCardProps interface must declare optional tooltip property'
    )
    assert.ok(
      content.includes('title={tooltip}'),
      'KpiCard element must set title attribute from tooltip prop'
    )
  })
})
