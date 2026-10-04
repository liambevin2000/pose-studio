# Pose Studio (prototype)

Pose mannequins in Blockbench and see them live in Minecraft Bedrock with Vibrant Visuals.

```
Blockbench plugin ──websocket──► Minecraft (/connect) ──/scriptevent──► behavior pack script
 (gizmos, camera)                                                     (teleport + entity properties)
                                                                                 │
                                         resource pack animation reads the properties via Molang
```

## Setup (once)

1. **Load the plugin from its link:** Blockbench desktop → File → Plugins → **Load Plugin from URL** → paste
   `https://raw.githubusercontent.com/liambevin2000/pose-studio/main/blockbench/pose_studio.js`.
   Blockbench downloads it again every time it starts, so updates arrive by themselves.
2. **Install the Minecraft packs:** Pose Studio → More → **Install Minecraft Packs** (Connect to Minecraft also offers it when they're missing). This downloads the packs into
   Minecraft's development pack folders (or double-click `dist/PoseStudio.mcaddon` instead).
3. **Create a test world:** Cheats ON, then add *Pose Studio* under Behavior Packs and Resource Packs.
4. **Enable Vibrant Visuals:** Settings → Video → Graphics Mode → Vibrant Visuals.
5. **Allow plain websockets:** Settings → General → turn **Require Encrypted Websockets** OFF.

## Working as a team

- **Shared scenes folder:** Pose Studio → More → **Folders…** → *Scenes folder*. Point everyone at the same shared folder (Dropbox, say). Save Location saves there, and when a world opens its locations are looked for there, subfolders included. Scenes are matched by **file name**, so it doesn't matter where each person's copy of the folder is.
- **Shared worlds (git, ToolBox):** a world remembers its locations, so whoever opens it gets offered them, as long as the scene files are in their scenes folder. World names come from the world folder's levelname.txt (as in Minecraft), or level.dat when there isn't one; never the zip name.
- **World not found?** The entity list and the world name come from the most recently played world folder. If that's wrong (worlds opened through other tools), use Locations → **Pick Minecraft World…** and pick the world folder: the one with level.dat and db in it, not the world_files zips. It's remembered for that world.
- **Another Minecraft install** (Preview, or data kept elsewhere): set *Minecraft data folder* in **Folders…**.

## Updates and changelog

- **Getting updates:** restart Blockbench (or File → Plugins → Pose Studio → Reload), or use File → Plugins → Pose Studio →
  Settings → **Pose Studio: Check for Updates**, which also updates the Minecraft packs when they've changed. Blockbench also checks by itself
  a few seconds after it starts and asks when something is out of date.
- **What changed:** File → Plugins → Pose Studio → **Changelog** tab (also in [CHANGELOG.md](CHANGELOG.md)). After an update,
  a short notice says which version you now have.
- Your skin library is kept when packs update.

### Publishing a new version (maintainer)

1. Make the changes.
2. Add an entry at the **top** of `changelog.json` with a higher version number and a line per change.
3. Run `node release.js`: it sets the plugin's version, writes CHANGELOG.md, updates `packs.json` (the file list the
   updater downloads) and rebuilds `dist/PoseStudio.mcaddon`.
4. Commit and push to `main`. Everyone gets it the next time Blockbench starts (GitHub can take up to 5 minutes to
   serve the new file).

## The Pose Studio menu

Everything is in the **Pose Studio** menu, next to Tools:

| Item | What it does |
|---|---|
| **Connect to Minecraft** | Turns the link on or off. When on, run `/connect 127.0.0.1:19131` in Minecraft. |
| **Locations ▸** | One world can hold several set-ups ("locations"), each its own scene file with its own imported terrain, entities, cameras and position in the world. **Save Location** saves the open one (the first time to `DocumentsPose StudioScenes<world>.bbmodel`) and links it with the Minecraft world you have open. **New Location Here…** asks for a name and starts a new scene tab centred where you stand (saved as `<world> - <location>.bbmodel`); keep building there and use **Import World…** for its terrain, without touching your other locations. **Locations…** lists the world's locations nearest first, to open, **Go There** (teleport), rename or remove. Minecraft only lets scripts place entities where chunks are loaded and ticking (normally just your simulation distance), so Pose Studio adds a ticking area around each location you open (named pose_…; Minecraft allows 10 per world). But Minecraft only draws the world (terrain and entities) around the player, so switching to a location more than about 100 blocks away takes you there (you're hidden and the camera is Pose Studio's anyway); turn this off in the plugin settings (Go to Locations) to be asked instead. If a ticking area can't be added, updates wait and appear as soon as you get there. Switch between open locations with Blockbench's tabs: each puts its own anchor back in Minecraft, and every location's entities stay set up in the world at the same time. When you connect, Pose Studio offers the location you're standing nearest (or switches to its tab). Each location remembers where it was built and lines itself up automatically when it opens; **Realign with World** does that on demand (stand inside the imported area). **Refresh in Minecraft** removes the open location's players and entities in Minecraft and places them again (it also happens by itself after Pose Studio takes you to a far location), for when they exist but aren't drawn. **Remove Location from World** takes the open scene off the world's list (the file stays). |
| **Add Mannequin** / **Skin & Equipment…** | With no mannequin selected this item is **Add Mannequin**: Adds a player mannequin named `Player_1`, `Player_2`… (scenes from older versions with `mq_N` mannequins still work) where the viewport is looking (on the scanned terrain if there is a scan), facing the camera. Move the group to place it; rotate `waist`, `body`, `head`, `rightArm`, `leftArm`, `rightLeg`, `leftLeg` to pose it. The bones are chained like Minecraft's player: the body sits in the waist and the head and arms in the body, so leaning the waist or body carries them. With a mannequin selected, the same place in the menu becomes **Skin & Equipment…**: one window with a **Skin** tab (the skin library below) and an **Equipment** tab (armour and held items). |
| **Add Entity…** | Opens a floating panel you can move, resize or dock, which stays open while you work: every entity in the world you're in, with thumbnails: Minecraft's own (read from your install) plus the world's resource packs, with pack models and textures replacing vanilla ones where a pack provides them. Search or filter by source, tick **Baby** to add baby versions, pick a world, or **Rescan** after editing a pack. Clicking an entity adds its real model as an `ent_…` group where the viewport is looking, facing the camera: move or turn the group to place it, and rotate its bones to pose it. In Minecraft it appears as a posable copy: one generated entity (`pose:proxy`) that can show any model in the world. Opening Add Entity… prepares it for the world's entities; reload Minecraft's packs once when asked (only again when the world's packs change), and after that every import is instant. Up to 19 bones per entity can be posed in game, and the whole group can be turned and tilted on all three axes. Store-bought Marketplace packs are encrypted and can't be read. |
| **Skin tab** (also **More ▸ Skin Library…**) | 16 skin slots shared by all projects. **Import Folder…** fills the empty slots with every 64×64 PNG in a folder (in name order; duplicates, other sizes and anything past 16 skins are skipped and listed). Or click an empty slot to add a single 64×64 skin PNG (slim or classic arms are detected; click the arm label to switch). With a mannequin selected, click a skin to dress it: instant in Blockbench and Minecraft, and several mannequins can wear the same skin. New or replaced skins show **needs reload** until Minecraft loads them: press **Reload Minecraft Packs** once (it runs `/reload all`, which briefly closes and reopens the world). **Take skin off** returns the mannequin to Steve. |
| **Equipment tab** / **Equipment…** | With an entity selected, **Equipment…** appears under Add Entity. **3D armour from your packs** (like DragonCraft's) is listed too: as **sets** (click a set to put the whole set on or take it off) and in each slot's list under *From your packs*. Pose Studio finds armour items (behavior pack, wearable armour slot) drawn by attachables (resource pack), and snaps each piece's model onto the matching bones (head, body, arms, legs), showing only the parts that piece shows (and the slim or classic sleeves to match the skin). Packs that restyle vanilla armour are shown restyled. Armour (leather, chainmail, iron, gold, diamond, netherite, copper, turtle helmet) and held items for the selected mannequin or entity (entities need hand bones and humanoid body bones, like zombies, skeletons and piglins; the dialog warns otherwise): pick from the icon grid or type any item id, including items from your packs. Minecraft puts the real items in the mannequin's slots, so they render and follow the pose like on a mob. Blockbench shows a preview: the real armour models, and a flat icon card for held items. |
| **3D weapons** | The Hands section of the Equipment tab lists **3D items from your packs** (DragonCraft's battle axes, daggers, longbows…). They show in the hand in Blockbench as their real models, placed the way Minecraft places them. A weapon that makes the player hold it a certain way (its pack's player animations, picked by the item's tags) brings that **holding pose** with it: the arms and the hand bone take the pose, and a **Holding pose** tickbox turns it on and off. In **Animation…** the held weapon's animations (attacks, blocks, combos) are listed first, marked ⚔. Players have **rightItem** / **leftItem** hand bones inside the arms: turn or move them to adjust a grip. |
| **Ride** | Select a player and a mob (Ctrl-click both), then Ride: the player sits on the mob's seat (read from the mob's minecraft:rideable, vanilla or pack), on its back, facing its way, in the riding pose. It stays on as the mob moves or turns; nudge the rider to adjust. Select a riding player alone and Ride again to get off. |
| **Drop to Ground** | Stands the selected players and mobs (Ctrl/Shift-click for several) on the imported terrain under their feet: the highest ground the feet cover, or the anchor's floor if there's no terrain under them. One undo step. |
| **Variant…** | With an entity selected: every look of that mob. A thumbnail grid for its main choice (coat, breed, biome…) plus a dropdown for each other choice and a **Baby** tickbox: horses have Markings and **Armour** (leather, iron, gold, diamond, copper, netherite); villagers and zombie villagers pick a **Biome** in the grid and a **Profession** from the dropdown; llamas have Decor. Looks drawn in several texture layers are merged into one texture for Minecraft. Click to swap the model and texture where it stands; bones keep the angles you gave them and applied animations stay. Every look is prepared for Minecraft together with the entities, so switching is instant there too. |
| **Animation…** | With a player or an entity selected. The left side lists its animations (walk, attack, sit, swim…; look-at-target and first-person ones are left out). Click one to show it (click others to look through them); **Shift+click** adds it to the **stack** on the right (Shift+click again to take it off), where each animation has its own frame slider (◀ ▶ step one frame) and **Play** plays the highlighted one. The live preview above the stack shows the model as it will look. Animations **add to the pose you already made** (a head you turned stays turned); tick **Reset pose** to start from the default pose instead. Stack several (say, walk and attack) to combine them, then **Apply** (one undo step) or **Cancel**. The model remembers its stack: open Animation… again and the same animations and frames are there to adjust, and any bones you posed by hand in the meantime keep that posing. Walk cycles move at a steady pace and attacks play once per loop. Only bone rotations are used, since Minecraft's copies can't move or scale bones. |
| **Held Items on Entities** (plugin page → Settings) | Shows held items on entity copies in Minecraft. Each copy can't draw what it holds, so an invisible mannequin is placed with its hand on the copy's hand and holds the item (in its main hand, since Bedrock's off hand refuses most items). On by default; turn it off if Minecraft disconnects (the choice is remembered). |
| **Add Camera ▸** | **From Minecraft View** saves your in-game view as a `cam_N` group, with the same field of view as your Minecraft FOV setting (only the camera view jumps to it; the viewport you work in stays where it is). **From Blockbench View** saves the viewport as one. Either way the new camera becomes the active one: the camera view opens on it and the Minecraft camera follows it. In the Generic Model format a camera is drawn as a line outline (a spline mesh, with a triangle marking its top); other formats use a simple block body and lens. |
| **Turning several at once** | Select two or more mannequins, entities and cameras (Ctrl/Shift-click in the outliner) and rotate: they swing around their shared centre as one piece, like a group, instead of each spinning on the spot. One undo puts them all back. |
| **Camera ▸ Camera FOV…** | Slider for the active camera's field of view (or the viewport's, if there's no camera). |
| **Camera ▸ Camera POV Viewport** | Splits the view top and bottom. The top is for working; the bottom is labelled **CAMERA VIEW** and locked to the active camera. While it's on, your player is invisible in game so it doesn't end up in shots (held items and armour still show). |
| **Camera view buttons** | Down the left side of the camera view, like Cinema 4D: drag the **hand** to move the camera left/right/up/down, the **arrows** to move it forward/back (drag up to go forward), the **circle** to orbit it around what it looks at (the nearest mannequin or entity in view, else 3 blocks ahead); hold **Shift** while dragging the circle to turn the camera on the spot. Each drag is one undo step, and Minecraft follows live when Sync Game Camera is on. |
| **Framing grid** | The grid button under the camera view's move buttons shows rule-of-thirds lines over the camera's picture (not the letterboxing). |
| **Camera view FOV slider** | Bottom left of the camera view: drag to change the active camera's field of view (30° to 110°) (Minecraft follows when Sync Game Camera is on). |
| **Time & weather** | While Blockbench is connected, the day/night and weather cycles are frozen (doDaylightCycle and doWeatherCycle off; they come back on when you disconnect; turn this off in File → Plugins → Pose Studio → Settings). Set the time of day with the slider in the bottom-right of the camera view (it shows the clock time) and pick clear, rain or thunder next to it, or use **Camera ▸ Time & Weather…** (with Sunrise / Morning / Noon / Sunset / Night presets). Each location saves its time and weather with **Save Location** and puts them back when it opens or you switch to its tab. |
| **Camera ▸ Aspect Ratio ▸** | **Fill View**: the camera view fills its half. **Match Minecraft Window**: it takes the Minecraft window's shape, updating within a second when you resize it. **16:9 Left Half**: Minecraft at 16:9 in the left half of its screen, Blockbench in the right half. **16:9, 21:9, 3:2, 4:3, 1:1, 4:5, 9:16**: resizes the Minecraft window to that shape (as large as fits its monitor, centred) and frames the camera view to match. Minecraft must not be in fullscreen (F11) for resizing to work. |
| **Camera ▸ Sync Game Camera** | The Minecraft camera follows the active camera (or the viewport, if there's none). Turning it on also sets the camera view to **Match Minecraft Window** (unless you picked another shape), so what you frame is what the game shows. |
| **Camera ▸ Look Through Camera / Follow Viewport** | Moves the working view to the active camera / makes the game camera follow the viewport instead of a camera. |
| **Import World…** | Brings the terrain around you into Blockbench as a `world_scan` mesh. The data comes back in large checked batches, several times faster than before. |
| **Capture Screenshot** | Hides the HUD and saves the Minecraft window to `Pictures/Pose Studio`. |
| **Compare with Game** (More) | Saves the game shot with Blockbench's outline (red) over Minecraft's (green), to show where armour or items are drawn differently. |
| **Capture Entities Only** | Saves the players and mobs on their own from the game camera: a transparent PNG and/or on the sky. The normal shot is taken first, with nothing moved, so the light is the scene's. For the cut-out, the blocks around them are cleared for about two seconds and then put back exactly. Needs Sync Game Camera. **Entity Shot Options…** picks what is saved: on their own, on the sky, the normal shot, normal, ID mask and depth passes, each player and mob separately, and whether particles are removed. |
| **More ▸** | Recenter Scene on Me, Skin Library… (manage skins with nothing selected), Reload Minecraft Packs, Remove Mannequins from World. Check for Updates, Debug Info and Held Items on Entities are on the plugin page (File → Plugins → Pose Studio → Settings). |

The **active camera** is the last `cam_N` group you selected. It stays active while you select and pose other things, until you pick another camera or choose **More ▸ Follow Viewport**.

## A typical shoot

1. Create a **Generic Model** project in Blockbench, turn on **Connect to Minecraft**, and run `/connect 127.0.0.1:19131` in Minecraft.
2. Walk to a spot you like. With an empty scene, connecting, scanning or grabbing a camera centres the scene on where you're standing, so there's no anchor to set. (**More ▸ Recenter Scene on Me** does it manually.)
3. **Import World…** traces the ground from above in a circle around you (so there are no gaps, including under trees and down cliff sides), then casts rays from your eyes to pick up trunks, walls and overhangs. The result is one `world_scan` mesh, with neighbouring faces merged so the viewport stays smooth. It can't be clicked in the viewport; select or delete it from the outliner. Scanning again replaces it, and Undo removes it.
4. Look at the shot you want and choose **Add Camera ▸ From Minecraft View**. The camera view opens on it and the game camera follows it. While Sync Game Camera is on, **From Minecraft View** saves the view Minecraft is showing (the active camera) as a new camera: a spare, or a starting point to tweak. To frame a new shot from your own view, turn Sync Game Camera off first.
5. Turn on **Camera POV Viewport** and **Sync Game Camera**. Add and pose mannequins in one half while the other half (and Minecraft) shows the camera's view. Move or rotate the `cam_N` group, or use **Camera FOV…**, to adjust the shot.
6. **Capture Screenshot**.

Cameras, their FOVs and the scan are saved with your Blockbench project. Turning **Connect to Minecraft** off leaves the mannequins in the world as they are. Scan results travel back through a hidden scoreboard objective called `pose_io`, which is removed after each transfer.

## Things to verify on first run

- **Direction:** Compare a mannequin in Blockbench with the one in game. Its facing and its left and right sides should match. If the scene is mirrored or backwards, edit `toWorld()` at the top of `pose_studio.js`.
- **Limb rotation:** Rotate an arm forward in Blockbench and check that it moves forward in game. If an axis is inverted, edit `toBedrockRot()`.
- **Vibrant Visuals:** If the Vibrant Visuals option greys out with the pack on, the RP manifest's `"capabilities": ["pbr"]` is the thing to check.
- **Connecting:** If `/connect` can't reach Blockbench on an older Microsoft Store build, run this once from an admin terminal:
  `CheckNetIsolation LoopbackExempt -a -n="Microsoft.MinecraftUWP_8wekyb3d8bbwe"`
- **Capture:** Run Minecraft windowed or borderless, not exclusive fullscreen.
- **Script errors:** Script warnings show in the Content Log. Turn it on under Settings → Creator.

## Gotchas we hit

- **Blockbench plugin modules:** Blockbench only lets plugins load an approved list of Node modules. `http` isn't on it, so the link is built on `net`.
- **Decimal rotation values:** the rotation values on the mannequin are declared as decimal numbers, so their `range` and `default` must be written as decimals (`[-180.0, 180.0]`, `0.0`). Written as whole numbers, Minecraft silently skips all of them, and `setProperty` fails with "Property … does not exist".
- **Reading picked files:** in the Blockbench desktop app, `Blockbench.import` with `readtype: 'image'` returns the file path, not the image data. The skin code reads files with `readtype: 'buffer'` and builds the data URL itself.
- **Reloading changes:** `/reload` only reloads scripts. Changes to the entity definition or the resource pack need the world to be closed and reopened.

## Editing the packs

After editing files in `packs/`, bump the `version` in both manifests and run `node build-mcaddon.js` before re-importing, or copy the folders into `development_behavior_packs` and `development_resource_packs` so changes load without version bumps.

## Stream Deck

Pose Studio has a plugin for Elgato Stream Deck (Stream Deck 6.5 or newer, Windows).

1. In Blockbench: **Pose Studio ▸ More ▸ Get the Stream Deck Plugin**, then double-click the downloaded `PoseStudio.streamDeckPlugin`.
2. In Blockbench: turn on **Pose Studio ▸ More ▸ Stream Deck Link** (it stays on).
3. In Stream Deck, drag keys from the **Pose Studio** category:

| Key | What it does |
| --- | --- |
| **Capture Screenshot** | Same as the menu's. |
| **Capture Entities Only** | Same as the menu's (what it saves is in Entity Shot Options). |
| **Camera** | Next, previous, or a numbered camera. A numbered key shows that camera's name and lights up while it's the active one. |
| **Toggle** | Sync Game Camera, Camera POV Viewport, or Connect to Minecraft. Lit while on. |
| **Time & Weather** | A time of day (sunrise, noon, sunset, night… or ticks) and/or a weather. |
| **Switch To** | Brings Blockbench (or Minecraft) to the front. |
| **Run Action** | Anything else from the Pose Studio menu (Drop to Ground, Compare with Game, Add Camera…). |

The link only listens on this computer (127.0.0.1:19132) and refuses requests from web pages. A key shows a warning triangle when Pose Studio isn't answering (Blockbench closed, or the link off).

The plugin's source is in `streamdeck/`; `node build-streamdeck.js` packs it into `dist/`.
