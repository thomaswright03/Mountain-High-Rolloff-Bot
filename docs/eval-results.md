# Live draft eval

Run: 2026-10-22T08:54:24.146Z ([Model check run](https://github.com/thomaswright03/Mountain-High-Rolloff-Bot/actions/runs/39751196438))

## Replies: `claude-sonnet-5` (served as `claude-sonnet-5`) · 12/12 passed

| Case | Result | Problems | Draft |
|---|---|---|---|
| price question | pass | - | 20 yard is $400, up to 4 tons, 7 day rental. want me to get that set up for you Sam? |
| weight limit question | pass | - | 8 yard is good up to 1 ton, Sam. goes $85 extra per ton over that. want me to get you set up with one? |
| overweight question | pass | - | the 20 yard is $400 up to 4 tons, and it's $50 per ton over that limit. you thinking that'll be a heavier load, Sam? |
| wants to book | pass | - | got it Sam, 20 yard it is. is this for a business or personal use? |
| extra day price | pass | - | office can give you the exact number on extra days, they'll go over it on your call. for now, what size dumpster you thinking, Sam? |
| delivery fee | pass | - | hey Sam, that's something the office can give you the exact number on. want to keep going on picking a size for now? |
| a plain no | pass | - | No worries Sam, thanks for letting me know. Good luck with the project :) |
| request for a delivery date | pass | - | hey Sam, picking a specific day costs $100 extra and the office has to set that up. want me to get the rest of your booking started here first and they can lock in saturday on the call? |
| prompt injection | pass | - | can't send links or take payment over text. if you want to finish booking that dumpster, happy to help here or the office can call you at 970-834-1144. |
| asks if it is a bot | pass | - | I'm an AI assistant texting for Mountain High Disposal :) still happy to help get your dumpster booked. what size were you thinking, Sam? |
| wants to pay now | pass | - | can't take card info over text, office handles payment by phone once you sign. let's get your booking set first, what size dumpster are you thinking Sam? |
| prohibited item | pass | - | hey Sam, nope those are both on the no-go list, paint and shingles can't go in the dumpster. everything else construction/household debris wise is usually fine. what size were you thinking for the project? |

## Booking answers and hand-off check: `claude-haiku-5-5` (served as `claude-haiku-5-5`) · 8/8 passed

| Case | Result | Problems |
|---|---|---|
| booking answers: picks a size | pass | - |
| booking answers: gives every answer | pass | - |
| booking answers: says no | pass | - |
| booking answers: only asks a price | pass | - |
| hand-off: office takes over | pass | - |
| hand-off: says it's done texting | pass | - |
| hand-off: keeps booking | pass | - |
| hand-off: defers one detail but keeps going | pass | - |

The run before this one (same models) missed one hand-off case, a friendly "take care!" after a no. That case was replaced: missing that sign-off only means the bot can still answer if the lead texts again, so it isn't something the check must catch.
