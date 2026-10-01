# Changelog

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
