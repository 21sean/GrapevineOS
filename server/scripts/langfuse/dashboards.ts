/**
 * Dashboards for the self-hosted Langfuse project.
 *
 * The project shipped with one dashboard ("Concierge health", six widgets) and
 * four read-only Langfuse-maintained ones, which left the Dashboards tab
 * looking like a demo shell. This builds four more, each a full page of tiles
 * that answers one question about Ask Grapevine:
 *
 *   1. Traffic and adoption       - who uses the concierge and how much
 *   2. Cost and tokens            - what answers cost, per model and per turn
 *   3. Quality and judges         - what judges, experiments and humans say
 *   4. Guardrails and reliability - rails, error levels and slow steps
 *
 * and adds four more tiles to "Concierge health" so the original dashboard
 * carries a summary row and a step-latency table rather than stopping at six.
 *
 * HOW IT TALKS TO LANGFUSE. Dashboards and widgets are written through
 * /api/public/unstable/{dashboards,dashboard-widgets,dashboards/:id/placements},
 * which take the same Basic auth as the ingestion keys. Two details matter:
 *
 *   - This deployment runs v4 in events_only mode, so the legacy ClickHouse
 *     traces and observations tables are empty and the "traces" view no longer
 *     exists on the write API. Trace-level tiles are built on the observations
 *     view with an isRootObservation filter and the traceId/uniq measure,
 *     which is what the query engine reads out of events_core anyway.
 *   - Every definition here is replayed against GET /api/public/v2/metrics
 *     before it is written, using the exact query the dashboard renderer would
 *     build (metrics[].agg becomes metrics[].aggregation, time-series charts
 *     get a timeDimension and no orderBy, breakdown charts get an automatic
 *     top-N orderBy, pivot tables take their orderBy from chartConfig
 *     defaultSort). A widget whose query is rejected, or whose grouped result
 *     contains an unlabelled bucket, is never written.
 *
 * FIVE RENDERER FACTS THIS FILE IS BUILT AROUND, all measured on 4.27.0:
 *
 *   1. An unlabelled bucket is the query engine telling you a group key is
 *      empty, not a rendering bug. Spans with no tags, no user and no session
 *      collapse into one giant "n/a" bar that dwarfs every real one. The
 *      dataset experiment family is exactly that shape: 1,560 spans in the
 *      sdk-experiment environment with no user, session or tag. Every grouped
 *      tile here therefore excludes the empty key it groups on, with
 *      notEmpty() below or a tags filter, rather than with an environment
 *      filter - a widget-level environment filter would override the
 *      dashboard's own environment selector (LFE-14333).
 *   2. PIE renders as a donut with a centre total and nothing else: no legend,
 *      no slice labels, no percentages. Five tiles used to be pies and were
 *      unreadable whatever the distribution, so they are bar charts now.
 *   3. A pivot table scrolls inside its tile, so a tile shorter than its table
 *      cuts the last row in half. Usable height is 74*h - 106 px, the header
 *      is 40px and a body row is 32px, and a two-dimension pivot renders a
 *      Total row plus one subtotal row per first-dimension group on top of its
 *      row_limit. PIVOT_ROWS below does that arithmetic so every table fits.
 *   4. USD is formatted by Langfuse as `value < 5 ? 6 : 2` fraction digits, so
 *      any tile whose numbers straddle $5 prints six decimals on one row and
 *      two on the rest. It is not settable per widget; the fix is to pick a
 *      shape whose numbers do not straddle it.
 *   5. A chart plots its FIRST metric and silently ignores the rest, whatever
 *      the chart type. Two metrics on a bar chart draw one bar, two on a time
 *      series draw one line. Multiple series have to come from a dimension.
 *      Pivot tables are the exception: they render every metric as a column.
 *
 * RE-RUNNABLE. There is no upsert for widgets or dashboards, so this converges
 * instead: widgets are matched by name (or by renameFrom for the one widget
 * that was replaced), and an existing row is PATCHed in place when its stored
 * definition differs from the one declared here. Placements are reconciled the
 * same way, so a changed tile height moves the tile that is already there
 * rather than adding a second copy. Nothing is deleted.
 *
 *   cd server && npx tsx scripts/langfuse/dashboards.ts
 *   flags: --dry-run   validate every definition and print the verdict, write nothing
 */
import "dotenv/config";

const BASE = process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000";
const PROJECT = "grapevine-local";
const AUTH =
  "Basic " +
  Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
  ).toString("base64");

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Types mirroring the unstable widget API
// ---------------------------------------------------------------------------

type Agg =
  | "sum" | "avg" | "count" | "max" | "min"
  | "p50" | "p75" | "p90" | "p95" | "p99"
  | "histogram" | "uniq";

type ChartType =
  | "LINE_TIME_SERIES" | "AREA_TIME_SERIES" | "BAR_TIME_SERIES"
  | "HORIZONTAL_BAR" | "VERTICAL_BAR" | "PIE"
  | "NUMBER" | "HISTOGRAM" | "PIVOT_TABLE";

type ChartConfig = {
  type: ChartType;
  row_limit?: number;
  bins?: number;
  show_value_labels?: boolean;
  defaultSort?: { column: string; order: "ASC" | "DESC" };
};

type Widget = {
  name: string;
  /** Previous name, for the one widget whose replacement changed what it is. */
  renameFrom?: string;
  description: string;
  view: "observations" | "scores-numeric" | "scores-categorical" | "scores-boolean";
  dimensions: { field: string }[];
  metrics: { measure: string; agg: Agg }[];
  filters: Record<string, unknown>[];
  chartType: ChartType;
  chartConfig: ChartConfig;
};

/** A widget plus where it sits on the 12-column grid of its dashboard. */
type Tile = Widget & { x: number; y: number; width: number; height: number };

type Placement = {
  type: "widget";
  id: string;
  widgetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Board = { name: string; description: string; tiles: Tile[] };

const TIME_SERIES: ChartType[] = ["LINE_TIME_SERIES", "AREA_TIME_SERIES", "BAR_TIME_SERIES"];

/**
 * Drop the rows whose group key is empty, which is what an "n/a" bar is made
 * of. The events schema stores these columns as non-nullable Strings, so the
 * empty string is the sentinel and "none of [""]" is the way to say "has one".
 * ("does not contain """ matches nothing, because every string contains the
 * empty string.)
 */
const notEmpty = (column: string) => ({
  column,
  operator: "none of",
  value: [""],
  type: "stringOptions",
});

/**
 * Only the concierge tags a trace, so this is the cleanest way to say "the
 * product, not the dataset experiments" without touching the dashboard's
 * environment selector. Experiment spans carry no tags at all.
 */
const CONCIERGE_ONLY = {
  column: "tags",
  operator: "any of",
  value: ["ask-grapevine"],
  type: "arrayOptions",
};

/**
 * How many body rows a pivot table can draw before the tile clips one in half.
 * Tile height in pixels is 74*h - 106 of usable area (measured off the live
 * grid: h=4 -> 280px outer, h=6 -> 428px outer, 90px of title and padding),
 * the sticky header is 40px and a body row is 32px.
 */
const PIVOT_ROWS = (h: number) => Math.floor((74 * h - 106 - 40) / 32);

// ---------------------------------------------------------------------------
// Widget definitions, grouped by the dashboard they belong to
// ---------------------------------------------------------------------------

const TRAFFIC: Board = {
  name: "Traffic and adoption",
  description:
    "How much the Ask Grapevine concierge is used, by whom, in which environment, and which tools it reaches for.",
  tiles: [
    {
      name: "Unique visitors",
      description: "Distinct user ids seen in the selected window.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "uniqueUserIds", agg: "uniq" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 0, y: 0, width: 4, height: 4,
    },
    {
      name: "Conversations started",
      description: "Distinct session ids, one per concierge thread.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "uniqueSessionIds", agg: "uniq" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 4, y: 0, width: 4, height: 4,
    },
    {
      name: "Traces recorded",
      description: "Distinct traces, one per answered turn or background job.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "traceId", agg: "uniq" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 8, y: 0, width: 4, height: 4,
    },
    {
      name: "Visitor turns over time",
      description: "Root spans per bucket, which is one bar per visitor turn.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [{ column: "isRootObservation", operator: "=", value: true, type: "boolean" }],
      chartType: "BAR_TIME_SERIES",
      chartConfig: { type: "BAR_TIME_SERIES" },
      x: 0, y: 4, width: 8, height: 6,
    },
    {
      // Was a PIE. Langfuse pies carry no legend and no slice labels, so four
      // unlabelled arcs said nothing; the same four numbers read fine as bars.
      name: "Traffic by environment",
      description: "Observations per environment, dataset experiments included.",
      view: "observations",
      dimensions: [{ field: "environment" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 10, show_value_labels: true },
      x: 8, y: 4, width: 4, height: 6,
    },
    {
      name: "Turns by visitor",
      description: "Busiest tester personas by number of concierge turns.",
      view: "observations",
      dimensions: [{ field: "userId" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [
        { column: "isRootObservation", operator: "=", value: true, type: "boolean" },
        notEmpty("userId"),
      ],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 12, show_value_labels: true },
      x: 0, y: 10, width: 6, height: 6,
    },
    {
      name: "Traces by tag",
      description:
        "One bar per whole tag set: the concierge tag plus the turn's topic and provider.",
      view: "observations",
      dimensions: [{ field: "tags" }],
      metrics: [{ measure: "traceId", agg: "uniq" }],
      filters: [CONCIERGE_ONLY],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 12, show_value_labels: true },
      x: 6, y: 10, width: 6, height: 6,
    },
    {
      name: "Tool calls by name",
      description: "How often the concierge reaches for each of its tools.",
      view: "observations",
      dimensions: [{ field: "calledToolNames" }],
      metrics: [{ measure: "toolCallInvocations", agg: "sum" }],
      filters: [],
      chartType: "VERTICAL_BAR",
      chartConfig: { type: "VERTICAL_BAR", row_limit: 15 },
      x: 0, y: 16, width: 6, height: 6,
    },
    {
      // The environment dimension used to be here too. Every session lives in
      // exactly one environment, so it only bought a duplicate subtotal row
      // per session and pushed the table past the bottom of the tile.
      name: "Conversation depth",
      description: "Observations and turns per conversation, deepest first.",
      view: "observations",
      dimensions: [{ field: "sessionId" }],
      metrics: [
        { measure: "count", agg: "count" },
        { measure: "traceId", agg: "uniq" },
      ],
      filters: [notEmpty("sessionId")],
      chartType: "PIVOT_TABLE",
      chartConfig: {
        type: "PIVOT_TABLE",
        row_limit: 12,
        defaultSort: { column: "count_count", order: "DESC" },
      },
      x: 6, y: 16, width: 6, height: 9,
    },
  ],
};

const COST: Board = {
  name: "Cost and tokens",
  description:
    "What the concierge costs to run: spend over time, spend by model, the prompt and completion split, and the conversations that cost the most.",
  tiles: [
    {
      name: "Spend to date",
      description: "Total USD across every costed generation in the window.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "totalCost", agg: "sum" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 0, y: 0, width: 4, height: 4,
    },
    {
      name: "Tokens consumed",
      description: "Input plus output tokens across every generation.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "totalTokens", agg: "sum" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 4, y: 0, width: 4, height: 4,
    },
    {
      name: "Generations billed",
      description: "Number of model calls in the window.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [{ column: "type", operator: "=", value: "GENERATION", type: "string" }],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 8, y: 0, width: 4, height: 4,
    },
    {
      name: "Spend over time",
      description: "USD per bucket. Local GPU inference is priced as an internal cost to serve.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "totalCost", agg: "sum" }],
      filters: [],
      chartType: "BAR_TIME_SERIES",
      chartConfig: { type: "BAR_TIME_SERIES" },
      x: 0, y: 4, width: 6, height: 6,
    },
    {
      // Was a PIE with no legend. The GENERATION filter also drops the
      // unnamed-model bucket that every non-model span would otherwise form.
      name: "Spend by model",
      description: "USD per model name across every generation.",
      view: "observations",
      dimensions: [{ field: "providedModelName" }],
      metrics: [{ measure: "totalCost", agg: "sum" }],
      filters: [notEmpty("providedModelName")],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 12, show_value_labels: true },
      x: 6, y: 4, width: 6, height: 6,
    },
    {
      // Was a stacked bar, which drew input + output + total and so stood at
      // twice the real height. usageType is a dimension the query engine adds
      // for you and cannot be filtered, so the total key cannot be dropped;
      // three unstacked lines say the same thing without the double count.
      // A second metric is not an option: a Langfuse chart plots only its
      // first metric, so extra series have to come from a dimension.
      name: "Tokens over time by type",
      description: "Prompt, completion and total tokens per bucket, as three unstacked lines.",
      view: "observations",
      dimensions: [{ field: "usageType" }],
      metrics: [{ measure: "usageByType", agg: "sum" }],
      filters: [],
      chartType: "LINE_TIME_SERIES",
      chartConfig: { type: "LINE_TIME_SERIES" },
      x: 0, y: 10, width: 6, height: 6,
    },
    {
      // Was three bars - input, output and their own sum - whose value labels
      // read $7.07 next to $4.055814, because Langfuse prints USD under $5 to
      // six decimals and $5 and over to two. Per bucket these are cents, so
      // the axis formats them alike, and the total reads as a line above the
      // two parts instead of a third bar the same size as both.
      name: "Input versus output cost",
      description: "Prompt, completion and total USD per bucket, as three unstacked lines.",
      view: "observations",
      dimensions: [{ field: "costType" }],
      metrics: [{ measure: "costByType", agg: "sum" }],
      filters: [],
      chartType: "LINE_TIME_SERIES",
      chartConfig: { type: "LINE_TIME_SERIES" },
      x: 6, y: 10, width: 6, height: 6,
    },
    {
      name: "Costliest conversations",
      description: "Conversations ranked by the USD spent answering them.",
      view: "observations",
      dimensions: [{ field: "sessionId" }],
      metrics: [{ measure: "totalCost", agg: "sum" }],
      filters: [notEmpty("sessionId")],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 10, show_value_labels: true },
      x: 0, y: 16, width: 6, height: 6,
    },
    {
      // The type dimension only ever read GENERATION here, so it bought a
      // duplicate subtotal row per model and clipped the table.
      name: "Model economics",
      description: "Calls, tokens, cost and tail latency for every model, priciest first.",
      view: "observations",
      dimensions: [{ field: "providedModelName" }],
      metrics: [
        { measure: "count", agg: "count" },
        { measure: "totalTokens", agg: "sum" },
        { measure: "totalCost", agg: "sum" },
        { measure: "latency", agg: "p95" },
      ],
      filters: [notEmpty("providedModelName")],
      chartType: "PIVOT_TABLE",
      chartConfig: {
        type: "PIVOT_TABLE",
        row_limit: 12,
        defaultSort: { column: "sum_totalCost", order: "DESC" },
      },
      x: 6, y: 16, width: 6, height: 9,
    },
  ],
};

const QUALITY: Board = {
  name: "Quality and judges",
  description:
    "Everything that grades a reply: the conversation judge, dataset experiments, guardrail scores and human annotation labels.",
  tiles: [
    {
      name: "Numeric scores recorded",
      description: "Every numeric score in the window, judge and rail alike.",
      view: "scores-numeric",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 0, y: 0, width: 4, height: 4,
    },
    {
      name: "Categorical labels recorded",
      description: "Human and judge labels, including the annotation queue's reply-quality verdicts.",
      view: "scores-categorical",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 4, y: 0, width: 4, height: 4,
    },
    {
      name: "Pass or fail checks",
      description: "Boolean scores, one per deterministic check.",
      view: "scores-boolean",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 8, y: 0, width: 4, height: 4,
    },
    {
      // Scoped to the four conversation judge metrics so every line shares a
      // 0 to 1 axis. Mixing in p95-latency-ms would flatten all of them.
      name: "Judge score trend",
      description: "Rolling average of each conversation judge metric, all on a 0 to 1 scale.",
      view: "scores-numeric",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "value", agg: "avg" }],
      filters: [
        { column: "name", operator: "starts with", value: "conversation.", type: "string" },
      ],
      chartType: "LINE_TIME_SERIES",
      chartConfig: { type: "LINE_TIME_SERIES" },
      x: 0, y: 4, width: 12, height: 6,
    },
    {
      name: "Score volume by name",
      description: "Which graders are actually running.",
      view: "scores-numeric",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 15, show_value_labels: true },
      x: 0, y: 10, width: 4, height: 6,
    },
    {
      // Was a PIE with no legend.
      name: "Where scores come from",
      description: "API, EVAL or ANNOTATION, which is the coverage of human review.",
      view: "scores-numeric",
      dimensions: [{ field: "source" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 10, show_value_labels: true },
      x: 4, y: 10, width: 4, height: 6,
    },
    {
      // Was a PIE of every categorical label at once, which put tool-choice's
      // "correct" next to hallucination-risk's "none" in one ring. Scoped to
      // the reply-quality verdict, which is what the tile is named after.
      name: "Review verdict mix",
      description: "Reply-quality verdicts from the judge, the API and human annotation.",
      view: "scores-categorical",
      dimensions: [{ field: "stringValue" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [{ column: "name", operator: "=", value: "reply-quality", type: "string" }],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 10, show_value_labels: true },
      x: 8, y: 10, width: 4, height: 6,
    },
    {
      // Replaces "Experiment scores over time", a line chart that could not
      // express what it wanted. Experiment runs are sparse events, so a time
      // axis gave one orphan dot per run and a filled "n/a" series across
      // every bucket with no run in it. A table has neither problem and shows
      // the runs side by side, which is what you actually compare.
      name: "Experiment run scorecard",
      renameFrom: "Experiment scores over time",
      description:
        "Mean quality score and sample count for every dataset experiment run. Grouped by the run's "
        + "trace name because experimentName is not an allowed widget dimension on the score views.",
      view: "scores-numeric",
      dimensions: [{ field: "name" }, { field: "traceName" }],
      metrics: [
        { measure: "value", agg: "avg" },
        { measure: "count", agg: "count" },
      ],
      filters: [
        { column: "traceName", operator: "contains", value: "experiment: ", type: "string" },
        {
          column: "name",
          operator: "any of",
          value: ["accuracy", "verdict-accuracy", "answered-the-question"],
          type: "stringOptions",
        },
      ],
      chartType: "PIVOT_TABLE",
      chartConfig: {
        type: "PIVOT_TABLE",
        row_limit: 12,
        defaultSort: { column: "avg_value", order: "DESC" },
      },
      x: 0, y: 16, width: 12, height: 10,
    },
    {
      // p95-latency-ms runs 783 to 3316 and dragged the Total row's mean to
      // 90.68 next to a column of 0-to-1 scores. Excluded so every number in
      // the table is on the same scale.
      name: "Judge scorecard",
      description:
        "Count, mean and tail for every 0-to-1 numeric score name and source. The millisecond "
        + "latency score is excluded so the table shares one scale.",
      view: "scores-numeric",
      dimensions: [{ field: "name" }, { field: "source" }],
      metrics: [
        { measure: "count", agg: "count" },
        { measure: "value", agg: "avg" },
        { measure: "value", agg: "p50" },
        { measure: "value", agg: "p95" },
      ],
      filters: [
        { column: "name", operator: "none of", value: ["p95-latency-ms"], type: "stringOptions" },
      ],
      chartType: "PIVOT_TABLE",
      chartConfig: {
        type: "PIVOT_TABLE",
        row_limit: 10,
        defaultSort: { column: "count_count", order: "DESC" },
      },
      x: 0, y: 26, width: 12, height: 11,
    },
  ],
};

const GUARDRAILS: Board = {
  name: "Guardrails and reliability",
  description:
    "Prompt Guard rail decisions, error and warning levels, and the steps that take the longest.",
  tiles: [
    {
      name: "Errors and warnings",
      description: "Observations logged above DEFAULT level.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [
        { column: "level", operator: "any of", value: ["ERROR", "WARNING"], type: "stringOptions" },
      ],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 0, y: 0, width: 6, height: 4,
    },
    {
      name: "Guardrail scans",
      description: "Rail spans emitted, one per input or content scan.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [{ column: "type", operator: "=", value: "GUARDRAIL", type: "string" }],
      chartType: "NUMBER",
      chartConfig: { type: "NUMBER" },
      x: 6, y: 0, width: 6, height: 4,
    },
    {
      name: "Rail score distribution",
      description:
        "Prompt Guard MALICIOUS probability across the input and content rails; block threshold 0.8.",
      view: "scores-numeric",
      dimensions: [],
      metrics: [{ measure: "value", agg: "histogram" }],
      filters: [
        {
          column: "name",
          operator: "any of",
          value: ["rail.input", "rail.content"],
          type: "stringOptions",
        },
      ],
      chartType: "HISTOGRAM",
      chartConfig: { type: "HISTOGRAM", bins: 20 },
      x: 0, y: 4, width: 6, height: 6,
    },
    {
      name: "Rail scans over time",
      description: "Guardrail spans per bucket, filled so quiet periods read as quiet.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [{ column: "type", operator: "=", value: "GUARDRAIL", type: "string" }],
      chartType: "AREA_TIME_SERIES",
      chartConfig: { type: "AREA_TIME_SERIES" },
      x: 6, y: 4, width: 6, height: 6,
    },
    {
      name: "Errors and warnings over time",
      description: "Above-DEFAULT observations per bucket, split by level.",
      view: "observations",
      dimensions: [{ field: "level" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [
        { column: "level", operator: "any of", value: ["ERROR", "WARNING"], type: "stringOptions" },
      ],
      chartType: "BAR_TIME_SERIES",
      chartConfig: { type: "BAR_TIME_SERIES" },
      x: 0, y: 10, width: 6, height: 6,
    },
    {
      // Was a PIE. One slice held 98 percent of the scans, so the donut was a
      // solid ring with an unlabelled sliver and no legend to explain it.
      name: "Guardrail outcomes",
      description: "Level of each rail span: DEFAULT allowed, WARNING would block, ERROR blocked.",
      view: "observations",
      dimensions: [{ field: "level" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [{ column: "type", operator: "=", value: "GUARDRAIL", type: "string" }],
      chartType: "HORIZONTAL_BAR",
      chartConfig: { type: "HORIZONTAL_BAR", row_limit: 10, show_value_labels: true },
      x: 6, y: 10, width: 6, height: 6,
    },
    {
      name: "Verdict labels by check",
      description: "Categorical scores grouped by the check that wrote them.",
      view: "scores-categorical",
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "count", agg: "count" }],
      filters: [],
      chartType: "VERTICAL_BAR",
      chartConfig: { type: "VERTICAL_BAR", row_limit: 12 },
      x: 0, y: 16, width: 6, height: 6,
    },
    {
      name: "Answer latency p95 over time",
      description: "Tail generation latency. Sparse buckets render as gaps, not zeroes.",
      view: "observations",
      dimensions: [],
      metrics: [{ measure: "latency", agg: "p95" }],
      filters: [{ column: "type", operator: "=", value: "GENERATION", type: "string" }],
      chartType: "LINE_TIME_SERIES",
      chartConfig: { type: "LINE_TIME_SERIES" },
      x: 6, y: 16, width: 6, height: 6,
    },
    {
      // The type dimension doubled the table with a subtotal row per step and
      // pushed it past the bottom of the tile. Name alone is the step.
      name: "Slowest steps",
      description: "Every span and generation name by count and latency, worst tail first.",
      view: "observations",
      dimensions: [{ field: "name" }],
      metrics: [
        { measure: "count", agg: "count" },
        { measure: "latency", agg: "p50" },
        { measure: "latency", agg: "p95" },
      ],
      filters: [],
      chartType: "PIVOT_TABLE",
      chartConfig: {
        type: "PIVOT_TABLE",
        row_limit: 15,
        defaultSort: { column: "p95_latency", order: "DESC" },
      },
      x: 0, y: 22, width: 12, height: 10,
    },
  ],
};

const BOARDS = [TRAFFIC, COST, QUALITY, GUARDRAILS];

/**
 * Extra tiles for the dashboard that already exists. These reuse widgets
 * defined above by name rather than creating near-duplicates, and sit below
 * the six original tiles, which occupy rows 0 to 13.
 */
const CONCIERGE_HEALTH = "Concierge health";
const CONCIERGE_EXTRAS: { widget: string; x: number; y: number; width: number; height: number }[] = [
  { widget: "Unique visitors", x: 0, y: 14, width: 4, height: 4 },
  { widget: "Spend to date", x: 4, y: 14, width: 4, height: 4 },
  { widget: "Errors and warnings", x: 8, y: 14, width: 4, height: 4 },
  { widget: "Slowest steps", x: 0, y: 18, width: 12, height: 10 },
];

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function lf<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api/public/unstable${path}`, {
    ...init,
    headers: { authorization: AUTH, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${body}`);
  return JSON.parse(body) as T;
}

/** Key order differs between what we send and what Langfuse stores. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, walk(x)]),
      );
    return v;
  };
  return JSON.stringify(walk(value));
}

// ---------------------------------------------------------------------------
// Pre-validation: replay the query the renderer would build
// ---------------------------------------------------------------------------

/**
 * Rebuild a widget's query the way DashboardWidget.tsx does, so a definition
 * the query engine would refuse never becomes a tile. Mirrors
 * buildWidgetOrderBy and toQueryChartConfig from the web bundle: pivot tables
 * take their orderBy from defaultSort, breakdown charts get an automatic top-N
 * on the first metric, and the query-side config keeps only type, bins and
 * row_limit. High-cardinality dimensions (userId, sessionId) are legal only
 * because of that orderBy, which is why the mirror has to be exact.
 */
function toMetricsQuery(w: Widget, from: string, to: string) {
  const isTimeSeries = TIME_SERIES.includes(w.chartType);
  const needsTopN =
    w.dimensions.length > 0 &&
    !isTimeSeries &&
    w.chartType !== "HISTOGRAM" &&
    w.chartType !== "PIVOT_TABLE";
  const first = w.metrics[0];

  const orderBy =
    w.chartType === "PIVOT_TABLE" && w.chartConfig.defaultSort
      ? [
          {
            field: w.chartConfig.defaultSort.column,
            direction: w.chartConfig.defaultSort.order.toLowerCase(),
          },
        ]
      : needsTopN && first
        ? [{ field: `${first.agg}_${first.measure}`, direction: "desc" }]
        : null;

  return {
    view: w.view,
    dimensions: w.dimensions,
    metrics: w.metrics.map((m) => ({ measure: m.measure, aggregation: m.agg })),
    filters: w.filters,
    timeDimension: isTimeSeries ? { granularity: "auto" } : null,
    orderBy,
    config: {
      type: w.chartType,
      ...(w.chartConfig.bins !== undefined ? { bins: w.chartConfig.bins } : {}),
      ...(w.chartConfig.row_limit !== undefined
        ? { row_limit: w.chartConfig.row_limit }
        : needsTopN
          ? { row_limit: 100 }
          : {}),
    },
    fromTimestamp: from,
    toTimestamp: to,
  };
}

/**
 * The widget create API is stricter about filter columns than the metrics API:
 * getWidgetImportFilterConfig(view) refuses anything outside this list, so
 * costType / usageType / experimentName are queryable as dimensions but are
 * not storable as filters. Checking here turns a mid-run 400 into a named
 * failure before anything is written.
 */
const CREATABLE_FILTER_COLUMNS: Record<Widget["view"], string[]> = {
  observations: [
    "environment", "type", "name", "level", "version", "userId", "sessionId", "tags",
    "release", "traceName", "traceRelease", "traceVersion", "providedModelName",
    "observationModelName", "promptName", "promptVersion", "toolNames", "calledToolNames",
    "metadata", "isRootObservation",
  ],
  "scores-numeric": [
    "name", "source", "value", "dataType", "tags", "environment", "userId", "sessionId",
    "metadata", "traceName", "observationName", "traceRelease", "traceVersion",
  ],
  "scores-categorical": [
    "name", "source", "stringValue", "dataType", "tags", "environment", "userId", "sessionId",
    "metadata", "traceName", "observationName", "traceRelease", "traceVersion",
  ],
  "scores-boolean": [
    "name", "source", "booleanValue", "dataType", "tags", "environment", "userId", "sessionId",
    "metadata", "traceName", "observationName", "traceRelease", "traceVersion",
  ],
};

function unstorableFilters(w: Widget): string[] {
  const allowed = new Set(CREATABLE_FILTER_COLUMNS[w.view]);
  return w.filters
    .map((f) => String(f.column))
    .filter((column) => !allowed.has(column));
}

type Verdict = { ok: boolean; populated: boolean; detail: string };

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value === "";
}

/** True when at least one returned metric value is non-zero and non-empty. */
function hasSignal(rows: Record<string, unknown>[]): boolean {
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key === "time_dimension") continue;
      if (Array.isArray(value) && value.length > 0) return true;
      if (typeof value === "number" && value !== 0) return true;
    }
  }
  return false;
}

async function validate(w: Widget, from: string, to: string): Promise<Verdict> {
  const rejected = unstorableFilters(w);
  if (rejected.length)
    return {
      ok: false,
      populated: false,
      detail: `filter column(s) the create API refuses: ${rejected.join(", ")}`,
    };
  const query = encodeURIComponent(JSON.stringify(toMetricsQuery(w, from, to)));
  const res = await fetch(`${BASE}/api/public/v2/metrics?query=${query}`, {
    headers: { authorization: AUTH },
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, populated: false, detail: `${res.status} ${body.slice(0, 220)}` };
  const rows = (JSON.parse(body).data ?? []) as Record<string, unknown>[];

  // A grouped chart with no time axis must never contain an unlabelled bucket:
  // that is the "n/a" bar, and it is always the thing you did not mean to plot.
  if (w.dimensions.length && !TIME_SERIES.includes(w.chartType)) {
    const fields = w.dimensions.map((d) => d.field);
    const blank = rows.filter((row) => fields.some((f) => isBlank(row[f])));
    if (blank.length)
      return {
        ok: false,
        populated: false,
        detail:
          `${blank.length} unlabelled bucket(s) in the result, e.g. ` +
          JSON.stringify(blank[0]).slice(0, 160),
      };
  }

  const top = rows.find((row) => !("time_dimension" in row));
  const label =
    w.dimensions.length && top
      ? ` top=${w.dimensions.map((d) => JSON.stringify(top[d.field])).join("/")}`
      : "";
  const populated = rows.length > 0 && hasSignal(rows);
  return { ok: true, populated, detail: `${rows.length} row(s)${label}` };
}

/** Warn when a pivot table is taller than the tile it has been given. */
function pivotFitWarning(tile: Tile, rows: number, groups: number): string | null {
  if (tile.chartType !== "PIVOT_TABLE") return null;
  // 1 Total row, plus one subtotal row per first-dimension group when the
  // pivot has more than one dimension, plus the rows themselves.
  const body = 1 + (tile.dimensions.length > 1 ? groups : 0) + rows;
  const capacity = PIVOT_ROWS(tile.height);
  return body > capacity
    ? `renders ~${body} rows but height ${tile.height} fits ${capacity}; raise the height or lower row_limit`
    : null;
}

async function pivotShape(w: Widget, from: string, to: string) {
  const query = encodeURIComponent(JSON.stringify(toMetricsQuery(w, from, to)));
  const res = await fetch(`${BASE}/api/public/v2/metrics?query=${query}`, {
    headers: { authorization: AUTH },
  });
  if (!res.ok) return { rows: 0, groups: 0 };
  const rows = (JSON.parse(await res.text()).data ?? []) as Record<string, unknown>[];
  const first = w.dimensions[0]?.field;
  const groups = first ? new Set(rows.map((r) => String(r[first]))).size : 0;
  return { rows: rows.length, groups };
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

type StoredWidget = Widget & { id: string };

/** The list endpoints cap limit at 100, so walk the pages. */
async function listAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const res = await lf<{ data: T[]; meta: { totalPages: number } }>(
      `${path}?page=${page}&limit=100`,
    );
    out.push(...res.data);
    if (page >= (res.meta?.totalPages ?? 1)) return out;
  }
}

const DEFINITION_FIELDS = [
  "name", "description", "view", "dimensions", "metrics", "filters", "chartType", "chartConfig",
] as const;

function definitionOf(w: Widget | StoredWidget) {
  return Object.fromEntries(DEFINITION_FIELDS.map((f) => [f, (w as never)[f]]));
}

/**
 * Validate, then create or converge every widget. An existing row whose stored
 * definition differs from the declared one is PATCHed in place, which is what
 * keeps a re-run from piling up near-duplicates: there is no upsert here.
 */
async function ensureWidgets(boards: Board[], from: string, to: string) {
  const existing = await listAll<StoredWidget>("/dashboard-widgets");
  const byName = new Map(existing.map((w) => [w.name, w]));
  console.log(`widgets: ${existing.length} already in the project`);

  const ids = new Map<string, string>(existing.map((w) => [w.name, w.id]));
  const empty: string[] = [];
  const refused: string[] = [];
  const warnings: string[] = [];

  for (const board of boards) {
    console.log(`\n${board.name}`);
    for (const tile of board.tiles) {
      const { x, y, width, height, renameFrom, ...widget } = tile;
      const verdict = await validate(widget, from, to);
      if (!verdict.ok) {
        refused.push(`${widget.name}: ${verdict.detail}`);
        console.log(`  REFUSED ${widget.name} -> ${verdict.detail}`);
        continue;
      }
      const note = verdict.populated ? verdict.detail : `${verdict.detail}, empty for now`;
      if (!verdict.populated) empty.push(widget.name);

      if (tile.chartType === "PIVOT_TABLE") {
        const shape = await pivotShape(widget, from, to);
        const warn = pivotFitWarning(tile, shape.rows, shape.groups);
        if (warn) warnings.push(`${widget.name}: ${warn}`);
      }

      const found = byName.get(widget.name) ?? (renameFrom ? byName.get(renameFrom) : undefined);
      if (found) {
        ids.set(widget.name, found.id);
        if (canonical(definitionOf(found)) === canonical(definitionOf(widget))) {
          console.log(`  = ${widget.name} (${note})`);
          continue;
        }
        if (DRY_RUN) {
          console.log(`  ~ ${widget.name} would be updated (${note}) [dry run]`);
          continue;
        }
        await lf(`/dashboard-widgets/${found.id}`, {
          method: "PATCH",
          body: JSON.stringify(widget),
        });
        console.log(
          `  ~ ${widget.name}${renameFrom && found.name === renameFrom ? ` (was "${renameFrom}")` : ""} -> ${found.id} (${note})`,
        );
        continue;
      }
      if (DRY_RUN) {
        console.log(`  + ${widget.name} (${note}) [dry run]`);
        continue;
      }
      const created = await lf<{ id: string }>("/dashboard-widgets", {
        method: "POST",
        body: JSON.stringify(widget),
      });
      ids.set(widget.name, created.id);
      console.log(`  + ${widget.name} -> ${created.id} (${note})`);
    }
  }

  if (refused.length) console.log(`\nrefused before writing:\n  ${refused.join("\n  ")}`);
  if (warnings.length) console.log(`\ntiles that would clip:\n  ${warnings.join("\n  ")}`);
  if (empty.length)
    console.log(`\nvalid but empty until more telemetry lands:\n  ${empty.join("\n  ")}`);
  return ids;
}

// ---------------------------------------------------------------------------
// Dashboards and placements
// ---------------------------------------------------------------------------

type Dashboard = {
  id: string;
  name: string;
  definition: { widgets: Placement[] };
};

async function listDashboards(): Promise<Dashboard[]> {
  return listAll<Dashboard>("/dashboards");
}

/** Reject a layout with overlapping or off-grid tiles before Langfuse sees it. */
function assertLayout(
  name: string,
  tiles: { x: number; y: number; width: number; height: number }[],
) {
  for (let i = 0; i < tiles.length; i++) {
    const a = tiles[i];
    if (a.x < 0 || a.x + a.width > 12) throw new Error(`${name}: tile ${i} runs off the 12-column grid`);
    for (let j = i + 1; j < tiles.length; j++) {
      const b = tiles[j];
      const overlaps =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlaps) throw new Error(`${name}: tiles ${i} and ${j} overlap`);
    }
  }
}

type Geometry = { x: number; y: number; width: number; height: number };

/**
 * Move an existing tile rather than adding a second copy of it. The REST
 * surface speaks width/height here; Postgres stores the same object as
 * x_size/y_size, so never hand-write that JSON.
 */
async function reconcilePlacement(
  dashboardId: string,
  label: string,
  widgetId: string,
  want: Geometry,
  placed: Map<string, Placement>,
) {
  const current = placed.get(widgetId);
  if (!current) {
    if (DRY_RUN) {
      console.log(`    + ${label} [dry run]`);
      return;
    }
    await lf(`/dashboards/${dashboardId}/placements`, {
      method: "POST",
      body: JSON.stringify({ type: "widget", widgetId, ...want }),
    });
    console.log(`    + ${label}`);
    return;
  }
  const same =
    current.x === want.x &&
    current.y === want.y &&
    current.width === want.width &&
    current.height === want.height;
  if (same) {
    console.log(`    = ${label}`);
    return;
  }
  const move = `${current.width}x${current.height}@${current.x},${current.y} -> ${want.width}x${want.height}@${want.x},${want.y}`;
  if (DRY_RUN) {
    console.log(`    ~ ${label} ${move} [dry run]`);
    return;
  }
  await lf(`/dashboards/${dashboardId}/placements/${current.id}`, {
    method: "PATCH",
    body: JSON.stringify(want),
  });
  console.log(`    ~ ${label} ${move}`);
}

async function ensureDashboard(board: Board, ids: Map<string, string>, boards: Dashboard[]) {
  // Check the whole intended layout, not just the tiles that resolved, so a
  // dry run still proves the grid is sound.
  assertLayout(board.name, board.tiles);
  const placeable = board.tiles.filter((t) => ids.has(t.name));

  const found = boards.find((d) => d.name === board.name);
  if (!found) {
    if (DRY_RUN) {
      console.log(`  + ${board.name} with ${placeable.length} tiles [dry run]`);
      return;
    }
    const created = await lf<{ id: string }>("/dashboards", {
      method: "POST",
      body: JSON.stringify({
        name: board.name,
        description: board.description,
        filters: [],
        definition: {
          widgets: placeable.map((t) => ({
            type: "widget",
            id: crypto.randomUUID(),
            widgetId: ids.get(t.name),
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
          })),
        },
      }),
    });
    console.log(
      `  + ${board.name} (${placeable.length} tiles) -> ${BASE}/project/${PROJECT}/dashboards/${created.id}`,
    );
    return;
  }

  console.log(`  ${board.name}`);
  const placed = new Map((found.definition?.widgets ?? []).map((p) => [p.widgetId, p]));
  for (const tile of placeable) {
    await reconcilePlacement(
      found.id,
      tile.name,
      ids.get(tile.name)!,
      { x: tile.x, y: tile.y, width: tile.width, height: tile.height },
      placed,
    );
  }
}

/** Append the summary row and step table to the dashboard that already exists. */
async function extendConciergeHealth(ids: Map<string, string>, boards: Dashboard[]) {
  const found = boards.find((d) => d.name === CONCIERGE_HEALTH);
  if (!found) {
    console.log(`  ! ${CONCIERGE_HEALTH} not found, skipping its extra tiles`);
    return;
  }
  const current = found.definition?.widgets ?? [];
  const placed = new Map(current.map((p) => [p.widgetId, p]));
  const extras = CONCIERGE_EXTRAS.filter((e) => ids.has(e.widget));
  // The six original tiles are not ours to move, so they only join the overlap
  // check; the extras below them are the ones this script positions.
  const untouched = current.filter((p) => !extras.some((e) => ids.get(e.widget) === p.widgetId));
  assertLayout(CONCIERGE_HEALTH, [...untouched, ...extras]);

  console.log(`  ${CONCIERGE_HEALTH}`);
  for (const extra of extras) {
    await reconcilePlacement(
      found.id,
      extra.widget,
      ids.get(extra.widget)!,
      { x: extra.x, y: extra.y, width: extra.width, height: extra.height },
      placed,
    );
  }
}

/**
 * The two tiles the first Langfuse pass hand-built on Concierge health select
 * concierge turns with `traceName = "ask-grapevine"`. That works for anything
 * this repo emits, because the seeding scripts set the raw
 * `langfuse.trace.name` attribute themselves, and it silently excludes the one
 * source that matters most: the live app. Its traces come from
 * @langfuse/langchain's CallbackHandler, whose constructor takes sessionId,
 * userId, tags, version and traceMetadata and has no traceName, so every real
 * turn lands with trace_name empty and drops out of both tiles.
 *
 * The root observation's own `name` is "ask-grapevine" in both worlds (the live
 * app sets it through runName in agent/index.ts), so switching the column makes
 * the tiles count real traffic and simulated traffic alike. Narrow and
 * idempotent on purpose: only the traceName clause is rewritten, only on
 * project-owned widgets that still carry it, and a second run finds nothing.
 */
async function retargetLegacyTraceNameFilters(): Promise<void> {
  const widgets = await listAll<StoredWidget>("/dashboard-widgets");
  const stale = widgets.filter((w) =>
    (w.filters ?? []).some(
      (f) => f.column === "traceName" && f.operator === "=" && f.value === "ask-grapevine",
    ),
  );
  if (!stale.length) {
    console.log("  = no widgets still select concierge turns by trace name");
    return;
  }
  for (const widget of stale) {
    const filters = widget.filters.map((f) =>
      f.column === "traceName" && f.value === "ask-grapevine" ? { ...f, column: "name" } : f,
    );
    if (DRY_RUN) {
      console.log(`  ~ ${widget.name}: traceName -> name [dry run]`);
      continue;
    }
    await lf(`/dashboard-widgets/${widget.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...definitionOf(widget), filters }),
    });
    console.log(`  ~ ${widget.name}: traceName -> name, so live app turns count too`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const to = new Date(Date.now() + 24 * 3600_000).toISOString();
const from = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
console.log(`validating against ${from} .. ${to}${DRY_RUN ? " (dry run)" : ""}`);

const ids = await ensureWidgets(BOARDS, from, to);

console.log("\nlegacy tiles:");
await retargetLegacyTraceNameFilters();

console.log("\ndashboards:");
const dashboards = await listDashboards();
for (const board of BOARDS) await ensureDashboard(board, ids, dashboards);
await extendConciergeHealth(ids, dashboards);

console.log(`\ndone - open ${BASE}/project/${PROJECT}/dashboards`);
