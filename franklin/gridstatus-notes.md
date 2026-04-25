# gridstatus.io — API research notes

Research for **Franklin**. Source: docs.gridstatus.io, gridstatusio Python client,
and probing the live API with our key.

## TL;DR

GridStatus.io aggregates near-real-time and historical data from every major
North American electricity market (ISO/RTO). One auth key, one consistent shape,
500+ datasets. Free plan is **rough** for production use (500k rows + 250
requests/month — see Limits) — hence the rotation strategy.

## Auth

- Header: `x-api-key: <key>`  *(or)* query param `?api_key=<key>`
- Get keys at https://www.gridstatus.io/settings/api
- We rotate `GRIDSTATUS_API_KEY_1`, `_2`, … (free plan keys are per-account, but
  any user with email can grab one; multiple emails ⇒ multiple keys)

## Endpoints

Base: `https://api.gridstatus.io/v1`

| Method | Path | Purpose |
|---|---|---|
| GET | `/datasets` | List all datasets (catalog). Returns rich metadata per dataset. |
| GET | `/datasets/{dataset_id}` | Full dataset detail (columns, types, time bounds, frequency). |
| GET | `/datasets/{dataset_id}/query` | **The main one.** Time-range query with filters/columns/resample. |
| GET | `/api_usage` | Plan limits + current period usage. |

### `/datasets/{id}/query` parameters
- `start_time` / `end_time` — ISO8601 (UTC). Can also be relative ("today", "1 day ago" — confirm).
- `columns` — comma-separated subset (saves rows-budget; smaller payload).
- `filter[<col>]=<value>` — equality filter on column. Multiple OK.
- `resample_frequency` — e.g. `1_HOUR`, `1_DAY`, `15_MINUTES` (down/upsample).
- `resample_function` — `mean`, `sum`, `min`, `max`, `first`, `last`.
- `limit` — cap rows in the response (def. up to plan's `api_rows_per_response_limit`).
- `cursor` / pagination — cursor-based paging when result exceeds per-response cap.
- `format` — `json` (default) or `csv`.
- `tz` — timezone for output.

## Free-plan limits (live, our key cf71…)

```
plan: Free
api_rows_returned_limit:    500,000 rows / month
api_requests_limit:         250 requests / month     ← brutal
api_rows_per_response_limit: 50,000 rows / response
per_second_api_rate_limit:  1
per_minute_api_rate_limit:  30
per_hour_api_rate_limit:    600
```

**Implication for Franklin:** rotation is essential. With 250 req/month per key,
even a low-rate background job blows through one key in a week. Plan to rotate
across N keys; cap each to ~80% (200 req) before swapping. Cache aggressively
(local sqlite/parquet) — never re-query the same row.

Paid plans lift these dramatically — escalate to a paid plan once Franklin goes
beyond research.

## Catalog (503 datasets total, snapshot 2026-04-25)

| Source | # datasets | What | Coverage |
|---|---:|---|---|
| **ercot** | 124 | Texas market — most granular | 5-min, 15-min, daily |
| **pjm** | 74 | Mid-Atlantic / Midwest | 5-min, 15-sec ACE |
| **caiso** | 63 | California + WEIM | 5-min, hourly |
| **ieso** | 53 | Ontario | hourly |
| **miso** | 45 | Midwest | 5-min, hourly |
| **isone** | 44 | New England | 5-min, hourly |
| **spp** | 38 | Southwest Power Pool | 5-min, hourly |
| **nyiso** | 27 | New York | 5-min, hourly |
| **aeso** | 21 | Alberta | 1-min, hourly, daily |
| **eia** | 10 | EIA reference (BA-level US) | hourly |
| **gridstatus** | 3 | Site rollups (`isos_latest`, etc.) | irregular |
| **hq** | 1 | Hydro-Québec | irregular |

## Most useful dataset families for Franklin

(Pulling out the patterns that recur across ISOs — what to reach for first.)

### Real-time prices (LMP)
- `caiso_lmp_real_time_5_min`, `ercot_lmp_real_time_5_min`,
  `nyiso_lmp_real_time_5_min`, `pjm_lmp_real_time_5_min`,
  `miso_lmp_real_time_5_min`, `isone_lmp_real_time_5_min`,
  `spp_lmp_real_time_5_min`
- Columns: `interval_start_utc`, `location`, `location_type`, `lmp`, `energy`,
  `congestion`, `loss` (sometimes `ghg` for CAISO)
- 5-min cadence ⇒ **HUGE** rows. **Always** filter by `location` and use
  resample to manage budget.

### Day-ahead prices (LMP)
- `*_lmp_day_ahead_hourly` family — same shape, hourly.

### Fuel mix (live MW by source)
- `caiso_fuel_mix`, `ercot_fuel_mix`, `nyiso_fuel_mix`, `pjm_fuel_mix`,
  `aeso_fuel_mix` (1-min!), `ieso_fuel_mix`, `miso_fuel_mix`, `isone_fuel_mix`,
  `spp_fuel_mix`
- Columns vary but always: `time_utc` + one column per fuel type
  (gas, coal, nuclear, hydro, wind, solar, storage, etc.)
- Best for "what's powering the grid right now" dashboards / decarbonization
  signal.

### Load + load forecast
- `*_load`, `*_load_forecast` — hourly, large historical horizon.
- Useful pair for accuracy / variance studies.

### Interchange (between ISOs)
- `aeso_interchange`, `pjm_actual_and_scheduled_interchange_summary`,
  `eia_ba_interchange_hourly` (31M rows!) — flows between balancing areas.

### Carbon intensity / emissions
- `eia_co2_emissions` (hourly, 5M rows) — CO2 by EIA balancing authority.
- Combine with fuel mix to compute custom carbon-intensity metrics.

### Ancillary services prices
- `*_as_prices*` — regulation/spinning/non-spinning reserve clearing prices.

### Constraints (where the grid is congested)
- `*_binding_constraints_*` — irregular but high-signal datasets showing where
  congestion is happening on transmission. Pairs with shadow prices.

### Generator-level data
- `ieso_generator_report_hourly`, `eia_monthly_generator_inventory_*`
- Plant-level outputs / fleet inventory.

### Market metadata
- `gridstatus.isos_latest` — site-wide rollup of "current" status across all
  ISOs (cheap call — useful as a homepage / health endpoint).

## Python client (recommended for Franklin)

```python
from gridstatusio import GridStatusClient

client = GridStatusClient(
    api_key=os.environ["GRIDSTATUS_API_KEY_1"],
    return_format="polars",      # or "pandas" / "python"
    max_retries=5,
    base_delay=2.0,
    exponential_base=2.0,
)

df = client.get_dataset(
    "caiso_fuel_mix",
    start="2026-04-20",
    end="2026-04-25",
    columns=["time_utc", "solar", "wind", "natural_gas"],
    resample="1_HOUR",
    limit=10_000,
)
```

- Auto-retries on 429 / 5xx with exponential backoff.
- `client.get_api_usage()` → check before/after each batch.
- `pip install gridstatusio[polars]` is the recommended fit (faster, lower mem).

## Rotation strategy (sketch for Franklin)

1. Load `GRIDSTATUS_API_KEY_*` from `.env` into an ordered list.
2. Persist last-known `current_period_usage` per key to a small json/sqlite.
3. On each request, pick the key with the most rows + requests left; if all are
   ≥ 80% utilized, hard-stop (don't silently truncate).
4. On 429/quota errors, mark the key cooled-down (reset after the
   `current_usage_period_end`).
5. Single shared cache (parquet by `(dataset, time-range, columns, filter)`),
   so re-queries are free. Use the dataset's `latest_available_time_utc`
   to know how stale the cache is and incrementally pull only new rows.

## Things to verify before depending on these (TBD)

- Whether free-plan keys can be created arbitrarily per email or are throttled.
- Exact `filter[col]` operator support (eq only? in? lt/gt?). Worth probing.
- WebSocket / streaming endpoints — none mentioned in current docs; near-real-time
  data is poll-only.
- Bulk export / parquet download for historical backfills (paid feature, likely).
- Test-mode key vs production — unclear if free keys differ.

## References

- API base: https://api.gridstatus.io/v1
- Catalog: https://www.gridstatus.io/datasets
- API settings (per-account): https://www.gridstatus.io/settings/api
- Pricing/plans: https://www.gridstatus.io/pricing
- Docs: https://docs.gridstatus.io/
- Python client: https://github.com/gridstatus/gridstatusio
- DeepWiki usage guide: https://deepwiki.com/gridstatus/gridstatusio/3-usage-guide
