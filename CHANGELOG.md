# Changelog

## 0.49.2 (2026-10-02)

- Fixed: scenes saved before 0.49.1 kept their misplaced armour until it was taken off and put back. Players with moved bones now get their armour rebuilt when the scene opens or Blockbench starts, connected to Minecraft or not.

## 0.49.1 (2026-10-02)

- Fixed: on players whose bones had been moved (a lowered waist, a leg pulled forward), Blockbench put the armour, and the skin when it was changed, where those bones rest instead of where they are. Minecraft puts them on the moved bones, so posed players looked different in Blockbench, the camera view and the normal pass. Armour and skins are now built on the bones where they are.
- Scenes saved before this are fixed when they're opened: players with moved bones get their armour built again, once.

## 0.49.0 (2026-10-02)

- Changed: the normal pass now follows Minecraft's exact outline of the players and mobs, taken from the cut-out. Anything Blockbench drew outside it is dropped. Anything Minecraft shows that Blockbench didn't draw (an item placed a little differently, a flail mid-swing) is filled with the colour of the nearest face. Its soft edges match the cut-out's.
- New: More > Compare with Game. It saves the game shot in grey with Blockbench's outline in red and Minecraft's own in green: red areas are drawn only by Blockbench, green only by Minecraft. Use it to show where Blockbench places armour and held items differently from Minecraft. Needs Sync Game Camera, like Capture Entities Only.

## 0.48.1 (2026-10-02)

- Changed: the normal pass now uses the Minecraft world's directions instead of the camera's: east is red, up is green, south is blue. A face's colour no longer depends on where the camera is, so tops of things are always green and a pass lines up with the world for relighting. Before, the colours turned with the camera.

## 0.48.0 (2026-10-02)

- Entity Shot Options has three new options. Each player and mob separately: as well as the group shots, each one is saved on its own (files named after it); the others go out of sight for its shots and come back after. Normal pass: each face coloured by the way it faces (camera space, x red, y green, z blue) on a transparent background, drawn by Blockbench from the shot's camera at the game window's size. Remove particles: each shot is taken three times, 0.4 seconds apart, and only what stays still is kept, so snow, rain and other moving particles drop out (it takes a little longer).
- The explanation text in Entity Shot Options is gone.
- Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.47.2 (2026-10-02)

- Fixed: Capture Entities Only failed with "UnloadedChunksError" when part of the area around the camera and the entities wasn't loaded (a camera away from where you stand). Minecraft now keeps that area loaded with a ticking area while the shot is taken, and waits up to 15 seconds for it before clearing. Blockbench waits for it too, so the coloured shots are only taken once the blocks are out.
- If the area can't be loaded, nothing is cleared and the shot stops with a message, instead of taking shots without the cut-out.
- Fixed: a failed clear could leave block drops switched off. Drops are now only switched off once every block has been saved.
- Fixed: error messages from Minecraft reached Blockbench with most of their letters missing.
- Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.47.1 (2026-10-02)

- Fixed: Capture Entities Only left the world near the entities in the shot (the ground, nearby trees, torches). For the two cut-out shots, the blocks in a box around the entities and the camera are now saved, cleared, and walled in with the flat colour. Straight after, every block is put back exactly as it was. The normal shot, which the colours come from, is still taken first with nothing touched, so the light on them is the scene's.
- While the blocks are out, block drops are off (a torch losing its wall drops nothing), and players standing in the box are held where they are. If the world closes mid-shot, the blocks go back when it opens again.
- Fixed: packs with their own HUD (like DragonCraft's hotbar) showed in shots, because /hud doesn't reach them. Capture Screenshot and Capture Entities Only now press F1 (hide interface) for each shot, and press it again after.
- Removed the Hide the ground option, which isn't needed now. Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.47.0 (2026-10-02)

- New: Capture Entities Only (in the Pose Studio menu, under Capture Screenshot). It saves the players and mobs on their own, without the world: a transparent PNG, and/or in front of the sky. It needs no developer build of Minecraft, and nothing in the scene is moved, so the light on them is exactly the scene's light. No HUD, no hand.
- How it works: from the game camera it takes the normal shot, then two quick shots with a flat-coloured box (magenta, then green) around the camera that hides the world behind the scene. What changes between those two shots is the background, which gives a clean cut-out with soft edges. The colours come from the normal shot. For the sky, one more shot is taken from straight above the camera, looking the same way. The box is only there for about two seconds.
- Entity Shot Options… sets what is saved: on their own, on the sky, and/or the normal shot. It also sets whether the ground under them is hidden: covered just below the lowest foot. Turn that off for shots from below or of things in the air. Parts of the world between the camera and the entities, such as grass at their feet, stay in the shot.
- Turn on Sync Game Camera first, and keep Minecraft visible while it shoots. Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.46.1 (2026-10-02)

- Fixed: Drop to Ground (and Ride, Animation…, Variant…, Equipment…) said to select a player or mob when you'd clicked a mob in the viewport. Newer Blockbench keeps the selected groups as a list, and when a cube is clicked that list is empty; Pose Studio now goes from the clicked cube to the mob or player it belongs to.

## 0.46.0 (2026-10-02)

- Removed first-person shots (Camera > First-Person Shot…). Any invisible seat a first-person shot left in a world is removed when the world opens. Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.45.1 (2026-10-02)

- Fixed: first-person shots with a low camera jolted back and forth: standing with your eyes at the camera put your legs in the ground, and Minecraft kept pushing you out. You now sit on an invisible seat (no collision, no gravity) placed so your eyes are exactly at the camera, whatever the terrain. Getting off puts you straight back on; the seat goes when the shot ends.
- Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.45.0 (2026-10-02)

- New: first-person shots (Camera > First-Person Shot…). The active camera shoots from the player's eyes in Minecraft's own first-person view, so the hand is in the shot, holding the items you pick for each hand (vanilla, your packs' 3D weapons in their first-person pose, or any item id).
- While the shot is on, you're moved to the camera and held there, and your invisibility is lifted so your arm shows; switching cameras or turning Sync Game Camera off gives back exactly what you were holding. The arm wears your own skin. Capture Screenshot hides the HUD but keeps the hand.
- Update the Minecraft packs (Check for Updates, then reopen the world).

## 0.44.5 (2026-10-02)

- Animation…: clicking an animation now shows just that one, so you can click down the list to look through them. Shift+click (or Ctrl+click) stacks several, as clicking did before. A weapon's holding pose and the riding pose stay on either way.

## 0.44.4 (2026-10-02)

- Fixed: after Minecraft updated, Skin & Equipment, Add Entity… and other windows could fail with "ENOENT … resource_packs": Pose Studio kept looking in the old version's install folder. It now notices the folder is gone and finds Minecraft again.

## 0.44.3 (2026-10-02)

- Fixed: animations on mobs were added on top of the idle pose the mob was set in when it was added, so mobs with a strong idle pose (DragonCraft's dragons: folded wings, curled neck and tail) came out scrambled. Like in Minecraft, animations now play on the model's own pose; anything you posed by hand stays on top. Taking every animation off brings back the idle pose.

## 0.44.2 (2026-10-02)

- Fixed: big mobs (DragonCraft's dragons have 28 and 37 bones) animated differently in Minecraft. A copy in Minecraft can pose 19 bones, and they were picked by name, so the dragons' bodies and wing parts weren't among them. Now the 19 are the bones the mob's own animations use most, and left/right pairs stay together (no lopsided wings).
- Animation… says when the stacked animations move bones Minecraft can't show for that model.
- Open Add Entity… once and reload Minecraft's packs when asked, so the copies pick up the new bones.

## 0.44.1 (2026-10-02)

- Fixed: some mobs (horses, pigs, sheep, chickens and others a pack builds from texture layers, like DragonCraft's) didn't show in Minecraft after being added. They're now added in the look Minecraft has a copy of, and ones already in your scenes find their copy again (always the same model).
- Faster riding: moving or turning a mob someone rides redraws only the rider, not the whole scene, so dragging it is smooth again.

## 0.44.0 (2026-10-02)

- New: Ride (Pose Studio menu). Select a player and a mob (Ctrl-click both) and Ride: the player sits on the mob's seat (from the mob's own definition: pigs, horses, camels, striders, DragonCraft's dragons and any pack mob with seats), on its back, facing its way, in Minecraft's riding pose. Dragons use the seat for their stage; a camel's second rider takes the back seat.
- Riders stay on: moving or turning the mob carries them, and moving a rider by hand changes its place on the mob. Select a riding player alone and Ride again to get off. Drop to Ground leaves riders on their mounts (drop the mob instead).

## 0.43.0 (2026-10-02)

- New: Camera > Aspect Ratio > 16:9 Left Half. Puts Minecraft at 16:9 in the top-left half of its screen and Blockbench in the right half, side by side.
- When Minecraft errors out while reloading its packs (a codeword like "Bat" in worlds with large packs), Pose Studio now explains what to do: open the world again from Minecraft's menu, which loads every pack fresh, then /connect.

## 0.42.1 (2026-10-02)

- Fixed: some pack mobs showed a different model in Minecraft than in Blockbench (DragonCraft's companions came in as a larva in Blockbench and an adult dragon in game). Looks picked by text values, like a companion's growth stage, are now understood: every stage is prepared for Minecraft, Variant… has a Stage choice (larva, young, adult), and a new companion comes in as its adult.
- A copy whose look Minecraft doesn't have yet is no longer shown as another model; Pose Studio asks you to open Add Entity… (which prepares it) instead.
- After updating, open Add Entity… once and reload Minecraft's packs when asked. Companions added before this may need Variant… to pick their stage again.

## 0.42.0 (2026-10-02)

- New: Drop to Ground (Pose Studio menu). Stands the selected players and mobs on the imported terrain under their feet (the highest ground they cover; with no terrain under them, the anchor's floor). The lowest point of a posed model is what lands, so a raised foot stays raised.
- New: mob bones move as well as turn, like players: in Animation… (pack animations that shift bones) and by hand, in Blockbench and in Minecraft. Mobs with up to 9 posable bones move on every bone; bigger models move their main bones (body, legs, arms, head, wings, tails) as room allows. Open Add Entity… once and reload Minecraft's packs when asked, so the copies pick this up.
- New: framing grid (rule of thirds) in the camera view: the grid button under the camera view's move buttons. The lines cover the camera's picture, and it remembers whether it was on.

## 0.41.0 (2026-10-01)

- Removed the sun tilt from Time & Weather. If you applied a tilt, Pose Studio takes its lighting copies out of its pack when Blockbench starts, so the packs' own lighting applies again (reopen the world to see it).

## 0.40.2 (2026-10-01)

- Fixed: Time & Weather opened empty (a broken tooltip stopped the window from drawing).

## 0.40.1 (2026-10-01)

- New: Put Pose Studio on Top (Time & Weather, when the pack order stops the sun tilt). With the world closed, it moves Pose Studio's resource pack to first in the world's list, keeping a backup of the old order.
- The pack-order note now points at the Resource packs tab (not Behavior packs).

## 0.40.0 (2026-10-01)

- New: Sun tilt in Camera > Time & Weather. Tilts the path the sun and moon take across the sky (Vibrant Visuals), so together with the time of day the sun can be put anywhere in the sky. Apply writes the world's lighting with that tilt into Pose Studio's pack and Minecraft reloads its packs (the world blinks). Pack Default goes back to the packs' own tilt.
- Each location keeps its sun tilt; opening a location with a different tilt offers to apply it.
- Pose Studio's resource pack has to be above packs with their own lighting (DragonCraft's) in the world's resource pack list; Time & Weather says when it isn't.
- Fixed: after switching worlds, Skin & Equipment could list the previous world's armour and items.

## 0.39.0 (2026-10-01)

- Fixed: cloaks (and other armour parts a pack animates from the wearer) can be posed. Turn the eq_cloak group forward or back in Blockbench and Minecraft follows: the mannequin passes the angle to the armour the way a player does (DragonCraft's cloak_angle).
- Armour previews now include the armour's own animations, so a cloak hangs at the same angle as in Minecraft.
- Update the Minecraft packs (Check for Updates, then close and reopen the world).

## 0.38.0 (2026-10-01)

- Fixed: animations now move bones as well as turn them, like in Minecraft. A block drops and shifts the waist and steps the legs apart; holds pull the arms in. This works in Blockbench and in Minecraft (waist, body, head, arms, legs and hand bones).
- Fixed: animations that keep the head relative to the entity (it stays level while the body leans) now do so.
- Moving a player's bone by hand (the waist, an arm, a leg) now shows in Minecraft too.
- Equipment is sent to Minecraft separately and only when it changes, so a fully equipped player's pose always fits in one command.
- Update the Minecraft packs (Check for Updates, then close and reopen the world): the mannequin's pose is stored in a new, more compact way.

## 0.37.0 (2026-10-01)

- Fixed: players now have the same bone chain as Minecraft's player model: a waist, the body in the waist, the head and arms in the body (legs on their own). Animations that lean the waist or body (a sprint leans forward) carry the head and arms with them, in Blockbench and in Minecraft.
- Players from older scenes are rebuilt into the new chain the first time they're used. Every bone keeps facing the way it faced.
- The waist can be turned by hand too, to lean the whole upper body.
- Update the Minecraft packs (Check for Updates, then reopen the world): the mannequin has the new bone chain.

## 0.36.0 (2026-10-01)

- New: 3D weapons and items from your packs (DragonCraft's battle axes, daggers, greatswords, longbows…) in Skin & Equipment, shown in the hand as their real models, placed the way Minecraft places them. Daggers put their second blade in the left hand.
- New: weapon holding poses. A weapon that makes the player hold it a certain way brings that pose with it (arms and grip). Turn it on or off with the Holding pose tickbox; changing weapons swaps it, and bones you posed yourself are kept.
- New: Animation… lists the held weapon's animations first (attacks, blocks, combos, marked ⚔), to stack and pick frames as usual. First-person animations are no longer listed.
- New: players have rightItem / leftItem hand bones inside the arms. Turn or move them to adjust how an item is held; Minecraft follows.
- Update the Minecraft packs (Check for Updates, then reopen the world): the mannequin has the new hand bones.

## 0.35.0 (2026-10-01)

- New: 3D armour from your packs (DragonCraft's, say) in Skin & Equipment. Whole sets are listed with icons (click a set to put it on or take it off), and every piece appears in its slot's list under From your packs.
- Custom armour snaps onto the mannequin in Blockbench: each piece's model goes on the matching bones (head, body, arms, legs) and shows only the parts that piece shows, with slim or classic sleeves to match the skin. Minecraft shows the real items.
- Packs that restyle vanilla armour (like DragonCraft's iron armour) are previewed restyled.
- Skin & Equipment reads the open world's packs (the picked world, else the last played one) even if Add Entity hasn't been opened yet.

## 0.34.2 (2026-10-01)

- When Minecraft drops the connection straight away ("Could not connect to server", usually because Require Encrypted Websockets is on), Blockbench now says so and how to fix it, instead of blaming the behavior pack.

## 0.34.1 (2026-10-01)

- World names come from levelname.txt first, as in Minecraft, and from level.dat only when there's no levelname.txt.

## 0.34.0 (2026-10-01)

- New: More > Folders… sets the scenes folder (a shared Dropbox folder, say) and the Minecraft data folder (for Minecraft Preview or other installs). Locations are looked for in the scenes folder and its subfolders.
- New: worlds shared through git work for everyone. A location saved on someone else's PC is found in your scenes folder by its file name.
- New: Locations > Pick Minecraft World… points Pose Studio at the open world's folder when it isn't found by itself (worlds opened through ToolBox, say). It's remembered for that world, and a folder of zipped worlds is caught with advice.
- New: More > Install Minecraft Packs downloads the behavior and resource packs into the development pack folders. Connect to Minecraft offers it when they aren't installed.
- World names now come from level.dat (what ToolBox sets) rather than levelname.txt.

## 0.33.6 (2026-10-01)

- Fixed: after going to another location, the camera view could show a much narrower (more zoomed in) picture than Minecraft, even though the game camera was right. Switching projects left the view drawn at an old size and shape, so the picture was cropped. The camera view now checks its size, aspect and zoom every frame and puts them right.

## 0.33.5 (2026-10-01)

- Fixed: the camera view could drift away from its camera (showing the camera from behind, or the inside of the terrain). Blockbench's orbit controls kept applying leftover movement to it, and a split view rebuilt by Blockbench (after switching tabs) was no longer followed. The camera view is now locked to its camera on every frame.

## 0.33.4 (2026-10-01)

- Add Camera ▸ From Minecraft View while Sync Game Camera is on now saves the view Minecraft is showing as a new camera (same position, angle and field of view), instead of switching the camera off. To frame a new shot from your own view, turn Sync Game Camera off first.

## 0.33.3 (2026-10-01)

- Fixed: going to a far location and keeping locations loaded never actually worked in game. The teleport and ticking-area commands named the dimension "minecraft:overworld", which Bedrock's execute command rejects (it wants "overworld"), and the failure was silent.
- Teleporting to a location is now done by the behavior pack's script (works across dimensions) and checked: if Minecraft did not take you there, Pose Studio says so instead of claiming it did.
- A ticking area that Minecraft refuses (a world allows 10) is reported.
- Needs the updated Minecraft behavior pack (Check for Updates, then reload the world).

## 0.33.2 (2026-10-01)

- Fixed: a location's players could turn up at a different location. When switching, updates went out before Minecraft's anchor had moved, and an update waiting for an unloaded area was later placed at whichever location was active by then. Updates now wait until the location is in place, and waiting updates are dropped when the anchor moves.
- Fixed: entity copies in an unloaded area reported "Pose Studio's entities aren't loaded yet" instead of waiting for the area like players do.
- Needs the updated Minecraft behavior pack (Check for Updates, then reload the world).

## 0.33.1 (2026-10-01)

- Fixed: after going to a far location, its players and entities could exist in Minecraft without being drawn. Entities created while you were away are not always sent to your screen when you arrive, so Pose Studio now places them again once you are there.
- New: Locations ▸ Refresh in Minecraft removes and re-places the open location's players and entities, for whenever they are missing.

## 0.33.0 (2026-09-30)

- Switching between far-apart locations now works reliably: Minecraft only draws terrain and entities around the player, so switching to a location more than about 100 blocks away takes you there automatically. The area loads, then its players and entities are placed. Turn off Go to Locations in the plugin settings to be asked instead.

## 0.32.3 (2026-09-30)

- Locations now keep their area loaded with a ticking area, so their players and entities appear even when you are far away or outside your simulation distance. Minecraft only lets scripts place entities in ticking chunks, which caused players to go missing.
- Debug Info (File > Plugins > Pose Studio > Settings) now shows where the open location is saved, where Minecraft's anchor is, where you are, and which world and pack version it sees. Minecraft also lists each Pose Studio entity's position in chat.
- Needs the updated Minecraft behavior pack (Check for Updates, then reload the world).

## 0.32.2 (2026-09-30)

- Fixed: a location far from the player showed no players and filled chat with LocationInUnloadedChunkError. Minecraft only loads the area around you, so its updates now wait and appear as soon as you get there.
- Switching to (or connecting with) a location that is far away offers to teleport you there.
- Locations… has a Go There button.
- Needs the updated Minecraft behavior pack (Check for Updates, then reload the world).

## 0.32.1 (2026-09-30)

- Connecting to a world now finds its locations even if the world never stored them (for example scenes saved while Blockbench was disconnected): Pose Studio also looks in DocumentsPose StudioScenes for scene files that belong to the world, offers them, and repairs the world's list.
- Pose Studio now always says something on connect: the location it found, that the world has none yet, or that the world's behavior pack is missing or out of date.
- A location removed from a world stays removed.
- Needs the updated Minecraft behavior pack (Check for Updates, then reload the world).

## 0.32.0 (2026-09-30)

- The day/night and weather cycles are frozen while Blockbench is connected (doDaylightCycle and doWeatherCycle off), and turned back on when it disconnects. There is a setting to turn this off.
- New time of day slider and clear/rain/thunder buttons in the camera view, and Camera ▸ Time & Weather… with presets.
- Each location saves its time and weather, and puts them back when it opens or you switch to it.

## 0.31.0 (2026-09-30)

- Locations: one world can hold several set-ups, each a scene of its own with its own imported terrain, entities, cameras and position in the world. The Scene menu is now Locations.
- Locations ▸ New Location Here… starts a new scene tab centred where you stand, so you can import that area and set up cameras without disturbing your other locations.
- Locations ▸ Locations… lists the world's locations nearest first, to open, rename or remove them. Switching tabs moves Minecraft to that location, and every location's entities stay set up in the world at once.
- When you connect, Pose Studio offers the location you are standing nearest.
- Needs the updated Minecraft behavior pack (Check for Updates). Scenes linked with 0.30 become the location "Main".

## 0.30.2 (2026-09-30)

- Scenes line themselves up automatically: when a linked scene connects or opens, Pose Studio compares its imported terrain with the terrain around you and moves it back if it is clearly offset. It only acts when you are standing in the scene's area and the match is unmistakable, and saves the corrected position into the scene file.

## 0.30.1 (2026-09-30)

- Fixed: opening a saved scene could put it in the wrong place in Minecraft. Connecting with an empty scene moved the world anchor to where you stood before the saved scene opened. Worlds with a scene now keep their anchor.
- Scenes remember where in the world they were built and put themselves back there when they open or when you switch to their tab.
- New: Scene ▸ Realign Scene with World finds the original position of a scene that lost it, by matching its imported terrain with the terrain around you.
- Minecraft requests now wait their turn instead of failing with "another transfer is running".
- Needs the updated Minecraft behavior pack (Check for Updates).

## 0.30.0 (2026-09-30)

- Scenes linked to worlds: Scene ▸ Save Scene saves with one click (to DocumentsPose StudioScenes the first time) and links the scene with the Minecraft world you have open.
- When you connect, Pose Studio offers to open that world's scene (or switches to its tab), warns if the open scene belongs to another world, and offers to link an unlinked scene.
- Scene ▸ Open This World's Scene and Unlink Scene from World.
- Needs the updated Minecraft behavior pack (Check for Updates).

## 0.29.0 (2026-09-30)

- Horse armour: Variant… on a horse has Markings and Armour dropdowns (leather, iron, gold, diamond, copper, netherite) alongside the coat.
- Villager variants: Variant… on a villager or zombie villager picks the biome (plains, desert, jungle, savanna, snow, swamp, taiga) and the profession, with the level badge as in game. Llamas get their decor too.
- The Variant window now has a grid for the main choice plus a dropdown for each other choice and a Baby tickbox.
- The camera view FOV slider now goes from 30° to 110°.
- Minecraft needs one pack reload after this update (open Add Entity… and accept the prompt) to load the new looks.

## 0.28.0 (2026-09-30)

- New: Variant… (with an entity selected) shows every look of that mob with thumbnails: biome and colour variants and baby versions. Click one to swap it where it stands, keeping its pose.
- New: a Baby checkbox in Add Entity adds baby versions directly.
- All variants and babies are prepared for Minecraft along with the entities, so switching is instant in game too (one pack reload after this update).
- Scan World is now Import World, and it is several times faster: the data comes back from Minecraft in large, checked batches and a more compact format. Update the Minecraft packs (Check for Updates) to get the speed-up.
- Turning on Sync Game Camera sets the camera view to Match Minecraft Window.
- The Animation window fits without a scroll bar.

## 0.27.1 (2026-09-30)

- The Animation window remembers what you applied: reopening it shows the same stack and frames instead of adding the animation a second time. Bones you posed by hand in between keep that posing.
- Click an animation in the list to add it, and click it again to take it off (the ✕ buttons are gone).

## 0.27.0 (2026-09-30)

- Animation Frame… is now Animation… and works for players as well as entities.
- Animations add to the pose you already made (a head you turned stays turned). Tick Reset pose to start from the default pose instead.
- Stack several animations, each at its own frame (for example walk plus attack), and remove any with ✕.
- A live preview of the model in the Animation window.
- Look-at-target and first-person animations are no longer listed.
- New mannequins are named Player_1, Player_2… (older mq_ mannequins still work).

## 0.26.0 (2026-09-30)

- New: Animation Frame… (with an entity selected). Pick one of the entity's animations, play or scrub through it, and keep the frame you like as its pose. Works with keyframed animations and with Minecraft's walk, attack and idle cycles.
- New: a field of view slider in the bottom-left corner of the camera view.

## 0.25.0 (2026-09-30)

- Add Camera ▸ From Minecraft View no longer moves the viewport you work in; only the camera view shows the new camera.
- Cameras grabbed from Minecraft get the same field of view as your Minecraft FOV setting.
- The camera view buttons (move, forward/back, orbit) moved to the left side of the camera view.

## 0.24.0 (2026-09-30)

- The camera view has Cinema 4D style buttons in its top-right corner: drag the hand to move the camera sideways and up/down, the arrows to move it forward/back, and the circle to orbit it around what it looks at (hold Shift to turn it on the spot). Each drag is one undo step.
- New cameras are drawn as a line outline (spline mesh) in the Generic Model format, with a triangle marking the top. Other formats keep the block camera.
- Smoother rotation when turning several selected objects together: only the moved objects are redrawn.

## 0.23.0 (2026-09-30)

- Rotating two or more selected mannequins, entities and cameras now turns them around their shared centre as one piece, instead of each spinning in place. One undo reverts the whole turn.

## 0.22.0 (2026-09-30)

- Add Camera now opens the camera view on the new camera and makes the Minecraft camera follow it.
- From Minecraft View while the game camera is synced first gives you your own view back to frame the next shot; choose it again to save.
- Tidier menu: the camera options are grouped under Camera (view, sync, FOV, aspect ratio, look through, follow viewport).
- The changelog is now in File > Plugins > Pose Studio > Changelog. Check for Updates, Debug Info and Held Items on Entities moved to that page's Settings tab.

## 0.21.0 (2026-09-30)

- Simpler menu: with no mannequin selected it shows Add Mannequin; select a mannequin and the same spot becomes Skin & Equipment…, one window with a Skin tab and an Equipment tab.
- With an entity selected, Equipment… appears for its armour and held items.
- Skin Library… (for adding and removing skins with nothing selected) moved to More.

## 0.20.1 (2026-09-30)

- Connect to Minecraft has a Copy Command button: paste the /connect command straight into Minecraft chat.

## 0.20.0 (2026-09-30)

- Pose Studio can now be shared from GitHub: install it with File > Plugins > Load Plugin from URL and Blockbench fetches the latest version every time it starts.
- New: More > Check for Updates installs or updates the Pose Studio Minecraft packs straight into your development pack folders (no .mcaddon needed), and updates the plugin.
- New: More > What's New shows this changelog, and it pops up once after each update.

## 0.19.3 (2026-09-30)

- Sheep show their face and legs in Minecraft instead of being all white.
- Spider and enderman eyes, the blaze, glow squid, magma cube and phantom no longer have see-through parts on entity copies.

## 0.19.2 (2026-09-30)

- Sheep have their body and legs under the wool again.
- The cat's and ocelot's tail is one piece, hanging down and back.

## 0.19.1 (2026-09-30)

- Skeletons, strays, bogged and wither skeletons stand normally instead of mixing attack, bow and sneaking poses.
- Cats and ocelots stand instead of lying or sitting; parrots stand instead of dancing.
- Fixed the default pose of villagers, zombie villagers, the wandering trader, enderman, witch, vex, sniffer, panda, snow golem, hoglin, turtle, wolf, spiders and llamas.
- Fixed doubled body parts on sheep, witches and zombie villagers.

## 0.19.0 (2026-09-30)

- Add Entity opens a floating panel you can move, resize or dock, and it stays open while you add entities.

## 0.18.1

- Earlier versions: posable mannequins, live link to Minecraft, cameras from Minecraft or Blockbench, world scan, camera FOV, split camera viewport with aspect ratios, skins and a skin library, every entity from your world with thumbnails, whole-body tilt, armour and held items, and correct resting poses for vanilla mobs.
