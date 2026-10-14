begin;
with corrections(id, starts_at, ends_at, recurrence, source_url) as (
  values
  ('twilight-in-the-park-57e42a','2026-06-16T18:30:00-07:00','2026-06-16T19:30:00-07:00','FREQ=WEEKLY;BYDAY=TU,WE,TH;UNTIL=20260827','https://balboapark.org/twilight-concerts/'),
  ('twilight-in-the-park-summer-concerts-83771e','2026-06-16T18:30:00-07:00','2026-06-16T19:30:00-07:00','FREQ=WEEKLY;BYDAY=TU,WE,TH;UNTIL=20260827','https://balboapark.org/twilight-concerts/'),
  ('free-friday-concerts-in-downtown-el-cajo-5714dc','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('free-friday-live-music-on-prescott-prome-3d02d1','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('friday-night-live-music-in-el-cajon-24b704','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('friday-night-live-music-on-prescott-prom-931e7c','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('friday-night-tribute-series-c20a84','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('music-on-main-in-downtown-el-cajon-eb5963','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('music-on-main-in-el-cajon-75ed5e','2026-06-05T18:00:00-07:00','2026-06-05T20:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260828','https://www.downtownelcajon.com/events/music-on-main'),
  ('nat-at-night-a9e013','2025-08-29T17:00:00-07:00','2025-08-29T23:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260904','https://www.sdnhm.org/calendar/nat-at-night/'),
  ('nat-at-night-at-the-natural-history-muse-6a46f2','2026-09-04T17:00:00-07:00','2026-09-04T23:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;COUNT=1','https://www.sdnhm.org/calendar/nat-at-night/'),
  ('the-nat-after-dark-9baa2d','2026-08-07T17:00:00-07:00','2026-08-07T23:00:00-07:00','FREQ=WEEKLY;BYDAY=FR;UNTIL=20260904','https://www.sdnhm.org/calendar/nat-at-night/'),
  ('chula-vista-farmers-market-133c1c','2026-10-18T10:00:00-07:00','2026-10-18T14:00:00-07:00','FREQ=WEEKLY;BYDAY=SU','https://downtownchulavista.com/events/chula-vista-farmers-market'),
  ('balboa-park-december-nights-256af6','2026-12-04T16:00:00-08:00','2026-12-04T22:00:00-08:00',null,'https://www.sandiego.gov/december-nights'),
  ('la-jolla-christmas-parade-holiday-festiv-16ca7a','2026-12-06T13:00:00-08:00','2026-12-06T17:00:00-08:00',null,'https://www.ljparade.com/'),
  ('concerts-on-the-green-fea401','2026-08-02T16:00:00-07:00','2026-08-02T19:00:00-07:00','FREQ=WEEKLY;BYDAY=SU;COUNT=1','https://www.pbtowncouncil.org/concerts/')
)
update public.events e set starts_at=c.starts_at::timestamptz, ends_at=c.ends_at::timestamptz, recurrence=c.recurrence, source_url=c.source_url,
dedupe_key=regexp_replace(lower(e.title),'[^a-z0-9]','','g') || '|' || coalesce(c.recurrence,to_char(c.starts_at::timestamptz at time zone 'America/Los_Angeles','YYYY-MM-DD'))
from corrections c where e.id=c.id;

-- These two imported rows stored the series' final date as one occurrence's
-- end. Retain that final date as UNTIL and restore a single evening's duration.
with corrected as (
select id, recurrence || ';UNTIL=' || to_char(ends_at at time zone 'America/Los_Angeles','YYYYMMDD') as rule,
  ((starts_at at time zone 'America/Los_Angeles')::date + (ends_at at time zone 'America/Los_Angeles')::time) at time zone 'America/Los_Angeles' as occurrence_end
from public.events where id in ('afterdark-at-adams-avenue-theater-e5f744','urban-pickleball-in-the-gaslamp-1cf701')
and ends_at-starts_at > interval '7 days' and recurrence !~ '(UNTIL|COUNT)='
)
update public.events e set ends_at=c.occurrence_end + case when c.occurrence_end < e.starts_at then interval '1 day' else interval '0 days' end,
recurrence=c.rule, dedupe_key=regexp_replace(lower(e.title),'[^a-z0-9]','','g') || '|' || c.rule
from corrected c where e.id=c.id;

update public.events set description='Year-round Sunday farmers market, 10 AM to 2 PM, beside Memorial Park. Produce, baked goods, flowers and local food vendors.' where id='chula-vista-farmers-market-133c1c';
update public.events set description='Friday session of the free Balboa Park holiday festival, December 4 from 4 PM to 10 PM. Saturday has a separate listing from noon to 10 PM.' where id='balboa-park-december-nights-256af6';
update public.events set source_url='https://www.spreckelsorgan.org/sundays' where id='spreckels-organ-sunday-jul12';
commit;
select count(*) as invalid_weekly_durations from public.events where recurrence like 'FREQ=WEEKLY%' and ends_at-starts_at > interval '7 days';

-- Additional verified summer season end dates.
begin;
with corrected as (
select id,
case id
when 'shark-summer-at-birch-aquarium-d86d0a' then '2026-07-01T09:00:00-07:00'::timestamptz
else starts_at end as start_at,
case id
when 'shark-summer-at-birch-aquarium-d86d0a' then '2026-07-01T17:00:00-07:00'::timestamptz
else ends_at end as end_at,
recurrence || ';UNTIL=' || case when id='shark-summer-at-birch-aquarium-d86d0a' then '20260802' else '20260907' end as rule,
case id when 'shark-summer-at-birch-aquarium-d86d0a' then 'https://aquarium.ucsd.edu/events/shark-summer'
when 'del-mar-summer-racing-season-9062ce' then 'https://web.dmtc.com/season'
else 'https://seaworld.com/san-diego/events/bayside-brews-and-bbq/' end as url
from public.events where id in ('shark-summer-at-birch-aquarium-d86d0a','del-mar-summer-racing-season-9062ce','seaworld-bayside-brews-bbq-festival-e04a6c')
and recurrence !~ '(UNTIL|COUNT)='
)
update public.events e set starts_at=c.start_at,ends_at=c.end_at,recurrence=c.rule,source_url=c.url,
dedupe_key=regexp_replace(lower(e.title),'[^a-z0-9]','','g') || '|' || c.rule
from corrected c where e.id=c.id;
update public.events set source_url='https://www.pbtowncouncil.org/concerts/' where id='concerts-on-the-green-fea401';
commit;
