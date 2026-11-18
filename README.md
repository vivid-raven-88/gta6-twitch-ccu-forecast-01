# GTA VI Twitch CCU Forecaster — make.fun entry

Forecasts, hour by hour, how many people watch Grand Theft Auto VI live on Twitch over the 24 UTC hours of its release day, from the first hour's count.

![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)
![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/vivid-raven-88/gta6-twitch-ccu-forecast-01/rank.svg)
![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/vivid-raven-88/gta6-twitch-ccu-forecast-01/reward.svg)

[make.fun bounty — gta6-twitch-ccu-forecast-01](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

## Method

`main.ts` (Node 22, standard library only) reads one case (`/input/<id>.in`) and writes
`/output/<id>.out`: for each of hours 2 to 24, five quantiles (5%, 25%, 50%, 75%, 95%) of
that hour's Twitch concurrent-viewer count in the "Grand Theft Auto VI" category.

It builds the forecast from the case's own `comparables` — past big launches' hourly Twitch
curves — at run time:

1. Take each comparable's release-day curve (24 hourly counts from its `day_start`).
2. Keep the curves whose hour-1 print is near this case's hour-1 print
   (|ln(h1_ref / p1)| <= 1.0, widening if too few qualify). Launch days scale with their
   opening hour, so a shape averaged over all sizes would over-shoot a big launch's evening.
3. For each forecast hour, the median of ln(viewers_h / viewers_1) over the kept curves is
   the shape: a dip overnight after the midnight unlock, recovery through the morning, and a
   peak in the US afternoon/evening.
4. Quantiles use a random-walk spread in log space,
   q_tau(h) = p1 * exp(median_h + z_tau * 0.15 * sqrt(h - 1)).

The program runs offline, with no network, and is deterministic: same input, same bytes out.

## Validation

Leave-one-out scoring over the kit's comparables: mean pinball loss 0.261 on big launches
(hour-1 print >= 20,000), against the flat persistence baseline's 0.326 on the same curves.
The baseline's own practice loss is 0.387.
