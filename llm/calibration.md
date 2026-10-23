# Judge calibration record

The starter baseline contains automated scores, not human calibration results.
Before expanding reliance on subjective gates, assign a maintainer to inspect ten
random live outputs plus every failure each month, and repeat after changing the
judge model or rubric. Keep private traffic out of this committed record.

Score independently before revealing the judge's score: 1 = all criteria met,
0.75 = minor issue, 0.5 = material omission, 0.25 = mostly wrong, 0 = unsupported
or contradictory. Record disagreements and convert recurring mistakes into
deterministic checks or explicit golden rubrics. Do not lower thresholds to make
a run pass. Store completed records below; no review is implied by this template.

| Date | Reviewer | Run source fingerprint | Case IDs | Human / judge scores | Agreement within 0.25 | Follow-up |
| ---- | -------- | ---------------------- | -------- | -------------------- | --------------------- | --------- |
