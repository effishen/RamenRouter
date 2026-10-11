# Preface

I built this for a very specific reason.

How small can I make a PCB, how much can I cram onto it, and how cheaply can I get it made?

Extra layers cost money. Finer traces cost money. Smaller holes cost money.
So let's fix those parameters and do some algorithmic gymnastics.

So, if you care more about making it fit AND work than making it pretty, meet Ramen Router.
100% vibe-coded. Ready to eat.

Runs in your browser. 100% online, 100% client-side processing.

Nothing to install. Just load your DSN, let it cook, and export your SES.

[Open RamenRouter](https://effishen.github.io/RamenRouter/)

## Get started

1. [Open RamenRouter](https://effishen.github.io/RamenRouter/) in your desktop browser.
2. Try the included demo, or import a **.dsn** board exported from your PCB editor.
3. Click **Start routing** and follow the progress.
4. Download the **.ses routing session** when the job finishes.
5. Import that session into the PCB editor you used to export the board.

## Use it offline

Download the [current RamenRouter folder](https://github.com/Effishen/RamenRouter/archive/refs/heads/main.zip),
extract the whole folder, and double-click **index.html**. Keep all the supplied files
together in that folder. No internet connection is needed for the downloaded app.

![RamenRouter showing a routed example board](images/demo.png)

## Working with your board

Place your components and set your board's routing rules in your PCB editor
before exporting the .dsn file.

Use the board preview to zoom, pan and show or hide layers. The job overview
shows progress and any connections still waiting to be routed. You can stop a
job, adjust the settings and try again.

The job overview shows the current **Attempt #**, **Time left**, and the
**Refinement** and **Finishing repairs** rounds. Remaining rounds are limits;
the job can finish earlier. Time left is the remaining job budget, not a
prediction of when routing will finish. The counts and timer freeze when you
stop, so you can review how far the job got.

When the time limit is reached, the job pauses at its next safe point. Choose
extra minutes and **Extend time** to continue the same work, including board
preparation before any traces have been drawn. Your progress and attempt
counts are kept. Leave this page open while paused. You can also stop and keep
the best checked result available.

During routing, the activity line and job log show what the engine is working
on, including grid preparation, fanout, path searches and result checks. The
last-update time tells you when the engine most recently reported progress.
With **Live work** enabled, the preview highlights the pads and copper being
examined, the grid rows being prepared, and the actual search branches and
candidate paths being tested. Trial paths are labelled separately from routed
tracks. The active item stays bright while recent work fades out. This applies
to pad and via inspections, grid preparation, fanout, trace refinement and
geometry checks as well as route searches. Highlights stay at the real
locations being examined; paths follow the actual reported segments.
The preview can show route paths for up to a quarter of your board's nets at
once, with a maximum of 25 work samples. It fills as the engine reports work,
so fewer may be visible. The display adjusts its refresh rate when drawing
gets busy; routing continues without waiting for an animation to finish.
Turn off **Live work** to hide these highlights. Reduced-motion settings keep
them still.

Already have a partly or fully routed DSN? Choose **Clear routing & start over**
below the loaded filename. After you confirm, RamenRouter removes all traces
and routing vias, including any fixed or protected ones. Components, pads,
connections and board rules stay in place, and your original file is unchanged.
Review the cleared board, then click **Start routing** when you are ready.
Download any result you want to keep before clearing it.

Open **Routing rules** to choose how the next run should work. **Routing
options** groups Smart search, pad escapes, refinement, time limits and other
switches in one place. **Apply** saves your choices; **Cancel** discards edits.

**Prefer alternating layer directions** encourages vertical traces on the
top layer, horizontal traces on the next layer, and alternating directions
through the stack. The dialog shows each layer's preference. It is off by
default and can deviate where needed; single-layer boards are unaffected.
Nets marked **Prefer shorter routes** keep their length priority. If routing
finishes with connections missing, RamenRouter offers to turn the direction
preference off and retry. It changes the setting only when you choose to.

Want a particular net to stay on one side of the board? In **Routing rules**,
open **Net rules**, find the net, and select its main routing layers.
You can choose one layer or several. If a surface-mount pad sits on another
layer and vias inside SMD pads are off, RamenRouter automatically tries a
short, full-width trace to a nearby via outside the pad. From there, the route
stays on the selected layers. This works at either end of a connection and
for imported layer rules too, even when general fanout is turned off.

The separate SMD-via option permits vias inside pads when enabled; it does
not require them. With all layers selected, routing keeps its usual behavior.
Every route still follows clearances, widths and the other routing rules.

If a pad's centre is blocked, RamenRouter also looks for room to connect
elsewhere inside that pad, keeping the requested trace width and clearance.

**Reset** restores that net's layer and shorter-route choices from your
imported file. These choices affect routing; the preview's **Visible layers**
controls only change what you see.

When you import another revision of a similar board, RamenRouter can offer
**Reuse previous routing rules?** It checks that the net names and connected
pins match, and that the layer names and order are compatible. The prompt
shows the previous and new filenames and how many nets have different choices.

Choose **Reuse previous rules** to carry over the selected main layers and
**Prefer shorter routes** choices. The new file supplies its own layout,
traces, vias, widths and other board rules. Choose **Use imported rules**, close
the dialog or press Escape to keep the new file's rules instead. Routing waits
for your choice. Reused rules are checked before they are committed; if that
fails, the new input is kept and you can retry or use its imported rules.

The latest board's net choices are remembered in this browser, including
across page refreshes when local storage is available. If saving is blocked,
they remain available during this page session. Only the matching information,
filename and per-net choices are remembered; board geometry and copper are not
stored. Nothing is uploaded, and this does not save the routed result.

Enable **Prefer shorter routes** for nets where length matters. RamenRouter
gives these nets earlier routing priority and favours shorter paths, even
when that needs more vias. With **Smart search**, it can keep looking for a
shorter result after making all connections. Completing the board and
respecting its routing rules still come first. This is a preference, not a
guarantee of the shortest possible path or a length-matching feature.

Recognised EasyEDA layer IDs are shown as **Top Layer**, **Inner1**,
**Inner2**, and **Bottom Layer**, with their original numbers in brackets.
They appear from top to bottom in the layer table and layer list.

Use a column's header checkbox to check or uncheck every net shown in the
table. With no search, this changes all nets. With a search, it changes only
matching nets; the other nets keep their selections.

Search with **\*** wildcards: **USB\*** finds names starting with USB,
**\*CLK** finds names ending with CLK, and **\*CLK\*** finds names containing
CLK. Searches ignore capitalisation. Plain text still finds any part of a name.

Changing routing options alone keeps your current result and affects the next
run. Save your result before applying per-net changes: these return the board
to its input routing, keeping its imported traces and vias. If existing traces
violate your layer choices, revise the selection or choose **Clear routing & start
over**. Pads and through vias keep their physical layer spans. Some layer
choices can leave pads hard to reach, so review any warnings, then click
**Start routing** when ready. Your exported DSN keeps your layer selections,
via-placement rules and shorter-route preferences for reopening in RamenRouter.

If no legal pad escape is found, the log identifies the affected pads instead
of retrying the same inaccessible connection on every pass. Review the pad
spacing, via size, obstacles and selected layers before trying again.

With **Smart search** enabled, RamenRouter checks its progress along the way
and tries focused repairs when only a few connections remain. More **Routing
attempts** gives it additional chances if needed. It keeps the best checked
result throughout.

**Stop job** stops routing and keeps the best checked attempt. Choose **View
best result** to see the remaining connections and placement advice, or **Keep
stopped** to leave the job stopped. Viewing a result does not restart routing.

Gentle highlights point to the next useful action: loading a board, starting a
run, reviewing advice or downloading a completed routing session.

If connections remain and vias in surface-mount pads could help, RamenRouter
offers **Enable and reroute**. This changes a board rule, so use it only if
your board can be manufactured with vias in those pads. You can also choose
**Keep current rules** and keep your existing result.

Alongside the .ses session, you can download a routed .dsn, a check report and
the job log.

If a board has overlapping pads or routing gets stuck, **Placement advice**
can point out areas to inspect. Choose **Show area** to find them on the board.
Make any placement changes in your PCB editor, export a new .dsn and try again.
Suggestions are starting points, not a promise that moving a part will finish
the board. When an export omits component names, advice uses pad and net labels.

## See how a run performed

Open **Run report** after routing to see how long it took, when the first
complete checked route was found, and where the processing time went. Review
the progress graph, search effort, attempts and repairs alongside the result's
remaining connections, rule issues, trace length and via count. Paused time
is kept separate. Stopped runs show the measurements received before stopping,
so you can distinguish partial measurements from a finished run.

For comparisons between computers, enable **Fixed-work benchmark** in
**Routing rules** before starting. It gives difficult fanout searches a fixed
amount of work instead of a machine-dependent time cutoff. You can still stop
the job or extend its time limit. Leave it off for normal routing.

Choose **Export benchmark** to save a report, then use **Compare benchmark**
on another computer to open it alongside that computer's result. Add a device
label to tell the runs apart. The exported report includes a board fingerprint
and settings, but no board geometry or net names. Keep the same input file,
rules, router version and Live work setting for a useful comparison.

The comparison explains when runs do not match. A speed comparison requires
finished, fully checked benchmark runs with matching work and results.
Browser and background activity can still affect the time; repeat a run when
a result looks unusual. This measures RamenRouter's single-worker browser
workload. It does not measure the performance of every processor core at once.

## Keep and review your results

Download anything you want to keep **before starting another run, closing the
page or reloading it**. Results are not saved automatically.

After importing the session into your PCB editor, review the routes, refill
copper zones if your board uses them, and run the editor's design-rule checks.
Some connections may still need to be finished by hand. Check the completed
board before sending it for manufacture.

[License](LICENSE)
