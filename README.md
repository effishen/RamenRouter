# RamenRouter

I built this for a very specific reason.

How small can I make a PCB, how much can I cram onto it, and how cheaply can I get it made?

Extra layers cost money. Finer traces cost money. Smaller holes cost money.
So let's fix those parameters and do some algorithmic gymnastics.

So, if you care more about making it fit AND work than making it pretty, meet Ramen Router.
100% vibe-coded. Ready to eat.

Runs in your browser. Everything is processed on your computer.

Nothing to install. Just load your DSN, let it cook, and export your SES.

[Open RamenRouter](https://effishen.github.io/RamenRouter/)

## Let's route a board

1. Place your components and set the board rules in your PCB editor, then export a **.dsn** file.
2. [Open RamenRouter](https://effishen.github.io/RamenRouter/) in a desktop browser and load that file. Or try the included example first.
3. Open **Routing rules** if you want to change the routing options or give individual nets their own rules.
4. Click **Start routing**.
5. Download the **SES routing session** and import it back into the editor that exported your board.

You can also download a routed DSN, a check report and the job log.

![RamenRouter showing a routed example board](images/demo.png)

## Want to use it offline?

Download the [current RamenRouter folder](https://github.com/effishen/RamenRouter/archive/refs/heads/main.zip), extract the whole folder, and double-click **index.html**.

Keep all the files together. Once you've downloaded the app, you don't need an internet connection.

## See what it's doing

Scroll to zoom, drag to pan, and press **F** to fit the board. **Visible layers** lets you show or hide layers. **Airwires** are guide lines for connections that still need routing; they aren't copper traces.

The job overview shows **Attempt #**, **Time left**, **Refinement** and **Finishing repairs**, including how many rounds are still available. Those are limits, so a run can finish before using them all. The time shown is the remaining job budget, rather than a prediction of when your board will be done.

The activity line and log explain what RamenRouter is working on. **Live work** highlights the pads, vias, search paths and checks happening on the board. Trial paths are shown separately from completed tracks. The preview shows a sample of the work, so you won't see every search. Turn it off if you prefer a quiet display. Reduced-motion settings keep the highlights still.

## More time, or call it a day

When the time limit runs out, the job pauses at the next safe point. Choose extra minutes and **Extend time** to carry on from there. This also works if it was still preparing the board and hadn't drawn any traces yet. Keep the page open while it's paused.

**Stop job** keeps the best checked attempt available. Choose **View best result** to see the missing connections and placement advice, or **Keep stopped** to leave it alone. Looking at the result doesn't restart anything. The timer and counts stay where you stopped.

If the board is complete, the export button gets a gentle highlight. If something needs attention, the app points you towards the relevant advice instead.

## Start over with an already routed board

Load your partly or fully routed DSN, then choose **Clear routing & start over** below the filename.

Save any result you want to keep first. After confirmation, this removes all traces and routing vias, including fixed or protected ones. Components, pads, connections, copper areas, the board outline and board rules stay in place. Copper is rebuilt, and the original file on your computer is unchanged.

Check the cleared board, then click **Start routing** when you're ready.

## Choose how it routes

Open **Routing rules → Routing options**. **Apply rules** saves your changes; **Cancel** discards them.

- **Smart search** gives difficult connections more attention and tries focused repairs when only a few remain. More **Routing attempts** gives it more chances. It keeps the best checked result along the way.
- **Ramen SMD escape** prepares extra short connections from surface-mount pads to nearby vias before routing. Connections needed to reach a net's chosen main layers are tried automatically, even with this switch off.
- **Optimize after routing** refines the routes and tries to reduce vias.
- **Prefer alternating layer directions** encourages vertical traces on the top layer, horizontal on the next, and alternating directions through the stack. The dialog shows the preference for each layer. It's off by default, can bend where needed, and has no effect on single-layer boards.
- **Allow vias in SMD pads** permits holes in those pads. It doesn't require them. Leave it off and RamenRouter tries to fan out to a via outside the pad when a layer change is needed. Turn it on only if your board can be made that way.
- **Routing attempts** and **Time limit** set the budget for the whole job.

Changing these options keeps your current result and affects the next run.

If connections remain with alternating directions enabled, you can choose to turn that preference off and retry. If vias in SMD pads might help, you can choose **Enable and reroute** or **Keep current rules**. Neither setting changes unless you choose it. Download the current result before retrying if you want to keep it.

## Give particular nets their own rules

In **Routing rules → Net rules**, find a net and tick its main routing layers. Pick one layer or several.

Checking a layer means: get to it, then stay there. If a pad sits on another layer, RamenRouter tries to reach the chosen layers with a nearby via. With vias in SMD pads off, it looks for a short, full-width escape to a via outside the pad. With the option on, a via inside the pad is also allowed. This works at either end of the connection, including rules imported with your board.

All layers selected? Routing works as usual. Clearances, trace widths and the other rules still apply. Pads and through vias keep their actual layer spans; these checkboxes don't change how your board is built.

If a pad's centre is blocked, RamenRouter also looks for a legal connection elsewhere inside it. If no escape fits, the log names the affected pads. Check their spacing, the via size, obstacles and your layer choices.

Tick **Prefer shorter routes** for nets where length matters. They get earlier access to space and more attention to shorter paths, even if that needs more vias. With **Smart search**, RamenRouter can keep looking for a shorter result after connecting the board. Finishing the board and following its rules still come first. This doesn't guarantee the shortest possible route or match trace lengths.

**Reset** restores a net's layer and shorter-route choices from your imported file. **Visible layers** only changes the preview.

Recognised EasyEDA layers are shown as **Top Layer**, **Inner1**, **Inner2** and **Bottom Layer**, from top to bottom, with their original numbers in brackets.

### Change a bunch of nets at once

Use a column's header checkbox to tick or untick every net shown in the table. No filter means all nets. With a filter, only the matching nets change.

Use **\*** as a wildcard:

| Search | Finds |
| --- | --- |
| **USB\*** | Names starting with USB |
| **\*CLK** | Names ending with CLK |
| **\*CLK\*** | Names containing CLK |

Search ignores capitalisation. Plain text finds any part of a name.

### Keep your result before applying net rules

Applying per-net changes returns the board to its input routing, including its imported traces and vias. Download the current result first if you want it.

If existing traces conflict with your layer choices, change the selection or use **Clear routing & start over**. Check any warnings, then start a new run.

Exported DSN files keep your layer choices, SMD-via rule and shorter-route preferences for reopening in RamenRouter. Temporary copper settings are saved separately.

## Same board, another revision?

When you load a similar board, RamenRouter can ask **Reuse previous routing rules?** It checks that the nets, connected pins and layer names and order match.

Choose **Reuse previous rules** to bring over your main-layer and shorter-route choices. The new file still supplies its own layout, traces, vias, widths and other board rules.

Your overall routing options stay as you set them.

Choose **Use imported rules**, close the dialog or press Escape to keep the new file's choices. Routing waits for you to decide. If the old choices can't be applied, the new input is kept and you can try again or use its imported rules.

The latest board's net choices are remembered in this browser when local storage is available. If saving is blocked, they're available only while the page stays open. This remembers matching details, the filename and per-net choices. It doesn't save the board geometry, copper or routed result. Nothing is uploaded.

## Let a copper plane do some of the work

I don't want a long trace for every GND connection if a copper plane can do the job.

Open **Copper fills** after loading your board. Use **Add whole-board fill** for a whole layer, or **Draw a copper area** to plot your own boundary. Pick the net and layer, such as GND on an inner layer. Add as many areas as you need, then edit or delete them later.

These are temporary areas used while routing in RamenRouter. Set up matching copper pours in your PCB editor for the actual board: the same net, layer, boundaries and connection settings.

### Set up the fill

Choose **Solid**, **Grid · 45°** or **Grid · 90°**. For grids, set the spacing and copper line width.

Choose **Direct** to connect pads straight to the surrounding copper, or **Spokes** for short copper bridges across a gap. Set the spoke gap and width, clearance from other nets, and clearance from the board edge. Your imported net clearance remains the minimum.

Leave **Keep unconnected islands** off to remove isolated copper with no connection to the net. Turning it on keeps those islands; it doesn't make them connected.

### Draw exactly where you want it

Click to place each boundary point. Choose **Finish shape**, press Enter or click the first point to close it.

**Undo point**, Backspace or right-click removes the last point. Scroll to zoom. **Cancel** or Escape leaves the previous shape in place.

Use **Draw a cutout** wherever you want this area to stay clear. You can redraw or delete each cutout. Existing board keepouts are respected too.

Choose **Apply & rebuild** to build the temporary fill and check its connections. The preview shows the filled result with its gaps and cutouts. The **Copper fills** checkbox only controls visibility.

A pad on another layer still needs a legal via or pad escape to reach the connected plane. An isolated bit of copper won't finish a connection.

### Keep copper settings separate

**If your imported DSN has no copper fills, your exported DSN has none either.** Original imported copper is kept. SES contains tracks and vias only. Temporary fills you add here stay in RamenRouter.

When exporting with temporary areas, choose **Save settings & export**, **Export routes only**, or cancel. The first option saves a separate copper settings file alongside your routes. You can also use **Save copper settings** after applying the areas.

Next time you load a board, choose a saved settings file when prompted, or carry on without one. You can load it later through **Copper fills → Load copper settings**. Nothing is applied automatically. The file is checked against the board before rebuilding the areas.

Back in EasyEDA, refill your matching copper pours and check connectivity and design rules. **A route that uses a plane needs that plane to make the connection.** Importing the tracks and vias alone won't supply it.

The separate settings file is for loading back into RamenRouter. It isn't an EasyEDA copper import file.

## Board won't finish?

Open **Placement advice** and choose **Show area** to find the problem spot. It can point out overlapping pads and suggest changes to try in your PCB editor. If the file doesn't include component names, you'll see pad and net labels instead.

Make the changes in your editor, export a new DSN and try again. Advice gives you somewhere to start; it doesn't promise that moving one part will finish the board.

## See how the run went

Open **Run report** after routing. See how long it took, when the first complete checked result appeared, and where the time went. The report also shows progress, attempts, repairs, remaining connections, rule issues, trace length and via count.

Paused time is kept separate. If you stopped early, the report shows only the measurements received up to that point.

Want to compare computers? Turn on **Fixed-work benchmark** in **Routing rules** before starting. It gives difficult fanout searches a fixed amount of work so the computers have a fairer task to compare. You can still stop or extend the run. Leave it off for everyday routing.

Use **Export benchmark** to save a report, then **Compare benchmark** on another computer to compare it with that machine's run. Give each machine a device label. The report includes a board fingerprint and settings, but no board geometry or net names.

Use the same board file, rules, RamenRouter version and **Live work** setting. A speed comparison needs finished, fully checked benchmark runs with matching work and results; the comparison points out mismatches.

Power settings, browser versions and other things running on your computer affect the time. Repeat a run if something looks odd. This measures RamenRouter's browser routing workload, rather than every processor core at once.

## Before you close the page or order the board

Download anything you want to keep **before another run, a refresh or closing the page**. Results aren't saved automatically.

Import the session into your PCB editor, review the routes, refill any copper pours and run the editor's checks. Some connections may need finishing by hand. Check the completed board before sending it for manufacture.

[License](LICENSE)
