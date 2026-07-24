# Supabase Database Schema

Reference for writing SQL against the Oz Tank POD Manager database.
Snapshot taken **2026-07-24** (after adding `customers.email_manually`).

> **Keeping this current:** whenever a column/table is added or changed, re-run the
> three introspection queries at the bottom of this file in the Supabase SQL Editor
> and update this document.

## How the app connects

- The app authenticates users with Google Sign-In, then calls
  `supabase.auth.signInWithIdToken()` — so app queries run as the **`authenticated`** role.
- RLS: every table requires `authenticated` for read/write (see [Policies](#row-level-security)).
  The `anon` key alone gets empty results. `calendar_sync_settings` additionally allows public read.

## Tables

### customers
| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | (PK, no sequence — ids assigned by app) |
| name | text | NO | |
| run_day | text | NO | |
| address | text | YES | |
| phone | text | YES | |
| service_type | text | YES | |
| carbsolve | text | YES | |
| waste | text | YES | |
| code | text | YES | |
| notes | text | YES | |
| "order" | integer | YES | 0 |
| created_at | timestamptz | YES | now() |
| special_instructions | text | YES | |
| business_group | varchar | YES | |
| is_active | boolean | YES | true |
| invoice_type | text | YES | |
| service_months | array | YES | (months 1–12; null = monthly) |
| frequency | text | YES | |
| tank_count | integer | NO | 1 |
| tank_labels | jsonb | YES | |
| myob_last_seen_at | timestamptz | YES | |
| invoice_under_id | bigint | YES | FK → customers.id (bills-under parent) |
| tank_ownership | text | NO | 'rental' ('rental' or 'user_owned') |
| email_manually | boolean | YES | false |
| no_delivery_fee | boolean | YES | false |

Note: `"order"` is a reserved word — always double-quote it in SQL.

### pods
| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | (PK, no sequence — ids assigned by app) |
| customer_id | bigint | YES | FK → customers.id |
| customer_name | text | YES | |
| customer_address | text | YES | |
| run_day | text | YES | |
| date | date | NO | |
| timestamp | timestamptz | NO | |
| tank_serviced | text | YES | |
| service_notes | text | YES | |
| products | jsonb | YES | |
| notes | text | YES | |
| photo | text | YES | |
| signature | text | YES | |
| customer_not_available | boolean | YES | false |
| archived | boolean | YES | false |
| created_at | timestamptz | YES | now() |
| is_ad_hoc | boolean | YES | false |
| carbsolve | text | YES | |
| service_type | text | YES | |
| source_run_day | text | YES | |
| signature_name | text | YES | |
| is_rental_only | boolean | YES | false |
| is_quick_complete | boolean | YES | false |
| calendar_event_id | bigint | YES | |
| completed_by | text | YES | |
| completed_at | timestamptz | YES | |
| tank_label | text | YES | |
| tank_services | jsonb | YES | |
| invoice_notes | text | YES | |
| link_excluded | boolean | NO | false |
| order_number | text | YES | |
| updated_at | timestamptz | YES | |

Note: `timestamp` and `date` are reserved-ish names — quote them when ambiguous.

### tank_movements
| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | (PK, no sequence — ids assigned by app) |
| customer_id | bigint | YES | FK → customers.id |
| customer_name | text | NO | |
| run_day | text | YES | |
| date | date | NO | |
| timestamp | timestamptz | YES | now() |
| movement_type | text | NO | |
| tank_no_placed | text | YES | |
| tank_no_pulled | text | YES | |
| carbsolve | text | YES | |
| reason | text | YES | |
| created_at | timestamptz | YES | now() |
| source_run_day | text | YES | |
| calendar_event_id | bigint | YES | |
| completed_by | text | YES | |
| invoice_notes | text | YES | |
| invoiced | boolean | YES | false |
| checked_sent | boolean | YES | false |
| invoiced_at | timestamptz | YES | |
| invoiced_by | text | YES | |
| link_excluded | boolean | NO | false |
| order_number | text | YES | |
| updated_at | timestamptz | YES | |

### worker_calendar_events
| column | type | nullable | default |
|---|---|---|---|
| id | integer | NO | PK, sequence |
| calendar_owner | text | NO | |
| event_date | date | NO | |
| event_title | text | NO | |
| event_id | text | YES | (Google Calendar id) |
| is_service_day | boolean | YES | false |
| service_day_name | text | YES | |
| created_at | timestamptz | YES | now() |
| sync_run_id | text | YES | |
| quick_complete | boolean | NO | false |
| description | text | YES | |
| location | text | YES | |

### calendar_event_status
| column | type | nullable | default |
|---|---|---|---|
| id | integer | NO | PK, sequence |
| event_id | integer | YES | FK → worker_calendar_events.id |
| status | text | YES | |
| notes | text | YES | |
| updated_at | timestamp (no tz) | YES | now() |
| actioned_by | text | YES | |
| actioned_at | timestamptz | YES | |
| invoice_notes | text | YES | |
| photos | jsonb | YES | |
| linked_customer_id | bigint | YES | |
| linked_by | text | YES | |
| linked_at | timestamptz | YES | |

### calendar_event_customer_links
| column | type | nullable | default |
|---|---|---|---|
| title_normalized | text | NO | PK |
| customer_id | bigint | NO | |
| linked_by | text | YES | |
| linked_at | timestamptz | YES | now() |

### customer_monthly_skips
| column | type | nullable | default |
|---|---|---|---|
| id | integer | NO | PK, sequence |
| customer_id | bigint | NO | |
| year_month | varchar | NO | |
| reason | varchar | YES | |
| created_at | timestamptz | YES | now() |
| skip_date | date | YES | |
| is_rental_only | boolean | YES | |
| skipped_by | text | YES | |
| skipped_at | timestamptz | YES | |

### invoice_status
| column | type | nullable | default |
|---|---|---|---|
| pod_id | bigint | NO | PK, FK → pods.id |
| invoiced | boolean | YES | false |
| created_at | timestamptz | YES | now() |
| checked_sent | boolean | YES | false |
| invoiced_at | timestamptz | YES | |
| invoiced_by | text | YES | |

### skipped_invoice_status
| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | PK (no sequence — ids assigned by app) |
| customer_id | bigint | NO | FK → customers.id |
| service_date | date | NO | |
| invoiced | boolean | YES | false |
| checked_sent | boolean | YES | false |
| invoice_notes | text | YES | |
| skipped_by | text | YES | |
| skipped_at | timestamptz | YES | |
| updated_at | timestamptz | YES | |

### monthly_invoice_entries
| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | PK, sequence |
| calendar_event_id | text | YES | |
| event_date | date | NO | |
| event_title | text | NO | |
| invoiced | boolean | YES | false |
| invoiced_at | timestamptz | YES | |
| invoiced_by | text | YES | |
| freight_added | boolean | YES | false |
| notes | text | YES | |
| created_at | timestamptz | YES | now() |
| updated_at | timestamptz | YES | now() |
| checked_sent | boolean | YES | false |
| sync_run_id | text | YES | |

### service_days
| column | type | nullable | default |
|---|---|---|---|
| name | text | NO | PK |
| employee | text | YES | |
| date | date | YES | |
| created_at | timestamptz | YES | now() |
| display_order | integer | YES | 0 |
| start_time | text | YES | '06:00' (24h "HH:MM"; shared run start time shown on run-day cards) |

### scheduled_service_days
| column | type | nullable | default |
|---|---|---|---|
| id | bigint | NO | PK, sequence |
| service_day_name | text | NO | |
| scheduled_date | date | NO | |
| calendar_event_id | text | YES | |
| calendar_event_title | text | YES | |
| created_at | timestamptz | YES | now() |
| updated_at | timestamptz | YES | now() |
| calendar_owner | text | YES | |

### service_day_invoice_status
| column | type | nullable | default |
|---|---|---|---|
| id | integer | NO | PK, sequence |
| service_day_name | text | NO | |
| service_date | date | NO | |
| invoiced | boolean | YES | false |
| invoiced_at | timestamptz | YES | |
| created_at | timestamptz | YES | now() |

### products
| column | type | nullable | default |
|---|---|---|---|
| id | integer | NO | PK, sequence |
| name | text | NO | |
| created_at | timestamptz | YES | now() |
| display_name | varchar | YES | |
| sku | varchar | YES | |
| category | varchar | YES | |
| is_carbsolve | boolean | YES | false |
| is_special | boolean | YES | false |
| is_active | boolean | YES | true |

### settings
| column | type | nullable | default |
|---|---|---|---|
| key | text | NO | PK |
| value | text | YES | |
| updated_at | timestamptz | YES | now() |

### calendar_sync_settings / calendar_sync_status
Sync bookkeeping tables (ICS url, last sync timestamps/status/messages,
`missing_days` array). `calendar_sync_status` is a singleton (`id` default 1).

## Relationships

```
customers.invoice_under_id      → customers.id      (bills-under parent, self-ref)
pods.customer_id                → customers.id
tank_movements.customer_id      → customers.id
skipped_invoice_status.customer_id → customers.id
invoice_status.pod_id           → pods.id           (also its PK — 1:1)
calendar_event_status.event_id  → worker_calendar_events.id
calendar_event_customer_links: keyed by normalized event title → customer_id (no FK)
```

Tables with **app-assigned bigint ids** (no sequence — the app generates ids, typically
`Date.now()`-based): `customers`, `pods`, `tank_movements`, `skipped_invoice_status`.
When inserting rows via SQL, supply an id the same way — do not rely on a sequence.

## Row-level security

All tables: full access requires the `authenticated` role (policies check
`auth.role() = 'authenticated'`). Exceptions/extras:

- `calendar_sync_settings`: public (anon) SELECT allowed.
- `skipped_invoice_status`: policy granted to the `authenticated` role directly.

SQL run in the Supabase SQL Editor bypasses RLS (runs as postgres), so these
policies matter for the app/API, not for admin queries.

## Regenerating this snapshot

```sql
-- 1. Columns
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 2. Keys
select tc.table_name, tc.constraint_type, kcu.column_name,
       ccu.table_name as references_table, ccu.column_name as references_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
left join information_schema.constraint_column_usage ccu
       on tc.constraint_name = ccu.constraint_name and tc.constraint_type = 'FOREIGN KEY'
where tc.table_schema = 'public' and tc.constraint_type in ('PRIMARY KEY','FOREIGN KEY')
order by tc.table_name;

-- 3. RLS policies
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename;
```
