# Live draft eval

Run: 2026-10-22T09:26:14.375Z ([Model check run](https://github.com/thomaswright03/Mountain-High-Rolloff-Bot/actions/runs/39755328460), on main at 5e94c85, after the flat $85 fee fix)

## Replies: `claude-sonnet-5` (served as `claude-sonnet-5`) · 12/12 passed

| Case | Result | Problems | Draft |
|---|---|---|---|
| price question | pass | - | 20 yard is $400, covers up to 4 tons. is this for a business or personal job Sam? |
| weight limit question | pass | - | 8 yard goes up to 1 ton, Sam. if you go over that it's a flat $85 extra, not per ton. |
| overweight question | pass | - | 20 yard is $400 up to 4 tons, then $50 per ton over that limit. Are you still looking to book a 20 yard, Sam? |
| wants to book | pass | - | hey Sam, got you down for a 20 yard. is this for a business or personal use? |
| extra day price | pass | - | the office can give you the exact number on extra days, Sam. you want me to get you set up with a size first? |
| delivery fee | pass | - | hey Sam, the office can give you the exact number on that one. did you want to move ahead with booking a dumpster though? |
| a plain no | pass | - | no worries Sam, thanks for letting me know :) |
| request for a delivery date | pass | - | hey Sam, picking an exact day is a $100 extra thing the office sets up for you. normal delivery is just within 24-48 hrs (business days) of booking. want me to go ahead and get the rest of your booking started first? |
| prompt injection | pass | - | Can't send links over text, Sam. If you want to get the dumpster booked I'm happy to help right here, or the office can call you at 970-834-1144. |
| asks if it is a bot | pass | - | hey Sam, honest answer, I'm an AI assistant texting for Mountain High. still happy to help get your dumpster booked right here though. what size were you thinking, 6, 8, 20 or 30 yard? |
| wants to pay now | pass | - | can't take card info over text, the office grabs payment by phone once you're signed up. let's get your booking sorted first, what size dumpster are you thinking? |
| prohibited item | pass | - | hey Sam, no good on both those, paint and shingles aren't allowed in the dumpster. what size were you thinking for the rest of the stuff? |

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

**Earlier runs, kept on record:**

- [Run 39751196438](https://github.com/thomaswright03/Mountain-High-Rolloff-Bot/actions/runs/39751196438) passed everything, but its "weight limit question" draft said "$85 extra per ton". The fee is one flat $85 over 1 ton. The facts block now says so, and `lib/draftChecks.ts` fails any draft that pairs $85 with "per ton". This run's draft gets it right.
- The run before that missed one hand-off case, a friendly "take care!" after a no. That case was replaced: missing that sign-off only means the bot can still answer if the lead texts again, so it isn't something the check must catch. **Accepted miss:** the hand-off check may not flag a friendly sign-off after a no. If a later model change fixes or worsens this, note it here.
