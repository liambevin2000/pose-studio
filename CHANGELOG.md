# Changelog

## 0.78.0 (2026-10-06)

- Fixed: a recording came back from Minecraft with its pieces out of order, so the recorded player jumped about.
- The recorded player follows DragonCraft's own rules for which animation plays when, and walks in step with the distance covered.
- Players in Minecraft now move their limbs smoothly between updates, and Smooth Movement is on by default.
- Update the Minecraft packs.

## 0.77.0 (2026-10-06)

- Record Player rebuilt. The recorded player now plays the pack's own idle, walk, sprint, sneak, jump and landing animations, and no longer jitters or twists.
- You stay visible while recording, a 3 second countdown starts it, and at the end you keep or discard the take.
- A line in the viewport shows the way a recorded player goes. A new player gets what you were wearing and holding.
- New option to try: Animate ▸ Smooth Movement in Minecraft.
- Update the Minecraft packs.

## 0.76.0 (2026-10-06)

- New (experimental): Record Player. Play your part in Minecraft and it comes in as a recording on a Pose Studio player.
- Move or turn that player afterwards and the whole recording moves with it.
- Update the Minecraft packs.

## 0.75.0 (2026-10-06)

- In the Animate tab, the Animation window places timeline keyframes: tick Place keyframe. You can preview the animation there first.
- A keyframe can start part-way into its animation (the frame slider).
- The separate Animation Key button is gone.

## 0.74.0 (2026-10-06)

- Any particle effect can be turned with its marker: sideways, towards something, or upside down so what falls rises.
- Tick "Turn the whole effect with the marker" in its settings. Minecraft reloads its packs once per effect.

## 0.73.0 (2026-10-06)

- Particles with a direction (wind, clouds) can follow their marker: turn the marker and the effect points that way.
- Only effects that read a direction can be aimed.

## 0.72.3 (2026-10-06)

- New scene files are named after what the world is called now, also after it was renamed.
- Existing scene files keep their names and keep working.

## 0.72.2 (2026-10-06)

- Narrow panel: back to two buttons per row, with smaller labels on two lines so they read in full.

## 0.72.1 (2026-10-06)

- The panel fits a narrow sidebar: one button per row, so labels are no longer cut off.
- Every panel button shows its name when you point at it.

## 0.72.0 (2026-10-06)

- Moving structures ignores air: empty space in the selection no longer wipes out what is at the landing place.
- Structure ▸ Ignore Air Blocks turns this off.
- Update the Minecraft packs.

## 0.71.0 (2026-10-06)

- Fixed: Import World stopped at about 48 blocks. Bigger radii now work, up to 128.
- Update the Minecraft packs.

## 0.70.0 (2026-10-06)

- New: Player View. Stands you at the active camera so Minecraft shows its own first-person view, hand included.
- Update the Minecraft packs.

## 0.69.0 (2026-10-06)

- New (experimental): Move Any Part. Every part of a big mob (dragons, riders on horses) can be moved and turned, and Minecraft follows.
- Turn it on in Settings, then open Add Entity once and reload Minecraft's packs when asked.

## 0.68.0 (2026-10-05)

- Variant has a Saddle tickbox for mobs that can wear one (DragonCraft's dragons, camels, donkeys, mules).
- Open Add Entity once and reload Minecraft's packs when asked.

## 0.67.0 (2026-10-05)

- New: particles. Add smoke, wind and other effects from your packs to the scene and move them in Blockbench.
- Update the Minecraft packs.

## 0.66.0 (2026-10-05)

- New (experimental): players and mobs have an Animation track on the timeline. Keyframe which animation plays when.
- Play Animation in Minecraft now plays players and mobs too.
- The animation actions are in a new Animate menu.
- Update the Minecraft packs.

## 0.65.1 (2026-10-05)

- Shorter, simpler changelog.

## 0.65.0 (2026-10-05)

- Removed the old camera path keys, window and menu.
- Camera animation is now in the Camera menu and on the panel.

## 0.64.0 (2026-10-05)

- New (experimental): animate the camera on Blockbench's timeline and play it in Minecraft.
- Update the Minecraft packs.

## 0.63.0 (2026-10-05)

- Camera paths: open a path in Blockbench's timeline to scrub it frame by frame.

## 0.62.0 (2026-10-05)

- Camera paths are now an experimental setting, off by default.
- Paths are shaped with handles in the viewport, and preview in the camera view.
- Update the Minecraft packs.

## 0.61.0 (2026-10-05)

- New (experimental): camera paths. Fly the game camera through keys, with speed ramps.
- Update the Minecraft packs.

## 0.60.1 (2026-10-05)

- Light level is a slider from 0 to 15. 0 turns the light off.

## 0.60.0 (2026-10-05)

- New: lights. Add light blocks to the scene and move them in Blockbench.
- Update the Minecraft packs.

## 0.59.0 (2026-10-05)

- The panel interface is now an experimental setting, off by default.

## 0.58.1 (2026-10-05)

- Fixed: day and weather cycles could stay frozen after a lost connection.

## 0.58.0 (2026-10-05)

- Fixed: a location built away from its starting point now loads its players and mobs.
- New: Go to Scene.

## 0.57.0 (2026-10-05)

- New: Remove Wild Mobs. Removes mobs Pose Studio didn't place, and their drops.
- The panel has a Location section.
- Update the Minecraft packs.

## 0.56.0 (2026-10-05)

- New: the Pose Studio panel, with buttons for the everyday actions.
- The Pose Studio menu is shorter.

## 0.55.0 (2026-10-05)

- New: Expand World. Adds more terrain to what is already imported.

## 0.54.0 (2026-10-04)

- Structure moves can be undone and redone, also with Ctrl+Z and Ctrl+Y.
- Connect to Minecraft unticks itself when the connection is lost.
- Update the Minecraft packs.

## 0.53.0 (2026-10-04)

- New: move structures. Select blocks in Minecraft, move them in Blockbench.
- Update the Minecraft packs.

## 0.52.3 (2026-10-04)

- Stream Deck: a Switch To key brings Blockbench or Minecraft to the front.

## 0.52.2 (2026-10-04)

- Stream Deck: key pictures follow what each key is set to.

## 0.52.1 (2026-10-04)

- Stream Deck: pixel-art keys, Minecraft style.

## 0.52.0 (2026-10-04)

- New: a Stream Deck plugin for captures, cameras, toggles, time and weather.

## 0.51.3 (2026-10-03)

- Fixed: Blockbench could read an old copy of a pack you are developing.

## 0.51.2 (2026-10-03)

- Fixed: equipment could be held back for good.
- Clearer message when the world has no such item.

## 0.51.1 (2026-10-03)

- Fixed: scenes naming renamed items caused errors. They are switched to the new names.

## 0.51.0 (2026-10-02)

- New entity shot passes: ID mask and depth.

## 0.50.1 (2026-10-02)

- Remove particles now also removes smoke.

## 0.50.0 (2026-10-02)

- Weapons and armour that swing by themselves now stay still on Pose Studio players and mobs.

## 0.49.2 (2026-10-02)

- Fixed: older scenes get their misplaced armour rebuilt when opened.

## 0.49.1 (2026-10-02)

- Fixed: armour and skins were misplaced on players with moved bones.

## 0.49.0 (2026-10-02)

- The normal pass follows Minecraft's exact outline.
- New: Compare with Game.

## 0.48.1 (2026-10-02)

- The normal pass uses the world's directions instead of the camera's.

## 0.48.0 (2026-10-02)

- New entity shot options: each player and mob separately, normal pass, remove particles.
- Update the Minecraft packs.

## 0.47.2 (2026-10-02)

- Fixed: Capture Entities Only failed when the area was not loaded.
- Update the Minecraft packs.

## 0.47.1 (2026-10-02)

- Fixed: Capture Entities Only left nearby blocks in the shot.
- Fixed: pack HUDs showed in shots.
- Update the Minecraft packs.

## 0.47.0 (2026-10-02)

- New: Capture Entities Only. Players and mobs without the world, transparent or on the sky.
- Update the Minecraft packs.

## 0.46.1 (2026-10-02)

- Fixed: actions said to select a player or mob when one was clicked in the viewport.

## 0.46.0 (2026-10-02)

- Removed first-person shots.
- Update the Minecraft packs.

## 0.45.1 (2026-10-02)

- Fixed: first-person shots with a low camera jolted.
- Update the Minecraft packs.

## 0.45.0 (2026-10-02)

- New: first-person shots, with the hand and held items.
- Update the Minecraft packs.

## 0.44.5 (2026-10-02)

- Animation: click shows one animation, Shift+click stacks several.

## 0.44.4 (2026-10-02)

- Fixed: windows failing with "ENOENT" after Minecraft updated.

## 0.44.3 (2026-10-02)

- Fixed: animations came out scrambled on mobs with a strong idle pose.

## 0.44.2 (2026-10-02)

- Fixed: big mobs animated differently in Minecraft.

## 0.44.1 (2026-10-02)

- Fixed: some mobs didn't show in Minecraft after being added.
- Faster riding.

## 0.44.0 (2026-10-02)

- New: Ride. Put a player on a mob.

## 0.43.0 (2026-10-02)

- New aspect option: 16:9 Left Half, Minecraft and Blockbench side by side.
- Clearer help when Minecraft fails to reload its packs.

## 0.42.1 (2026-10-02)

- Fixed: some pack mobs showed a different model in Minecraft than in Blockbench.

## 0.42.0 (2026-10-02)

- New: Drop to Ground.
- Mob bones can move as well as turn.
- New: framing grid in the camera view.

## 0.41.0 (2026-10-01)

- Removed the sun tilt.

## 0.40.2 (2026-10-01)

- Fixed: Time & Weather opened empty.

## 0.40.1 (2026-10-01)

- New: Put Pose Studio on Top, for the sun tilt.

## 0.40.0 (2026-10-01)

- New: sun tilt in Time & Weather.
- Fixed: Skin & Equipment could list the previous world's items.

## 0.39.0 (2026-10-01)

- Cloaks can be posed.
- Update the Minecraft packs.

## 0.38.0 (2026-10-01)

- Animations and hand posing now move bones as well as turn them.
- Update the Minecraft packs.

## 0.37.0 (2026-10-01)

- Players have the same bone chain as Minecraft's player, with a waist.
- Update the Minecraft packs.

## 0.36.0 (2026-10-01)

- New: 3D weapons and items from your packs, with their holding poses and animations.
- Update the Minecraft packs.

## 0.35.0 (2026-10-01)

- New: 3D armour from your packs in Skin & Equipment.

## 0.34.2 (2026-10-01)

- Clearer message when Minecraft drops the connection straight away.

## 0.34.1 (2026-10-01)

- World names come from levelname.txt first.

## 0.34.0 (2026-10-01)

- New: Folders, Pick Minecraft World and Install Minecraft Packs.
- Worlds shared through git work for everyone.

## 0.33.6 (2026-10-01)

- Fixed: the camera view could look zoomed in after switching location.

## 0.33.5 (2026-10-01)

- Fixed: the camera view could drift away from its camera.

## 0.33.4 (2026-10-01)

- From Minecraft View while synced saves the current game view as a new camera.

## 0.33.3 (2026-10-01)

- Fixed: going to far locations and keeping them loaded did not work.
- Update the Minecraft packs.

## 0.33.2 (2026-10-01)

- Fixed: a location's players could turn up at another location.
- Update the Minecraft packs.

## 0.33.1 (2026-10-01)

- Fixed: players and entities at a far location could be invisible.
- New: Refresh in Minecraft.

## 0.33.0 (2026-09-30)

- Switching to a far location takes you there automatically.

## 0.32.3 (2026-09-30)

- Locations keep their area loaded.
- Debug Info shows more.
- Update the Minecraft packs.

## 0.32.2 (2026-09-30)

- Fixed: far locations showed no players.
- New: Go There.
- Update the Minecraft packs.

## 0.32.1 (2026-09-30)

- Connecting finds a world's locations from your scene files too.
- Update the Minecraft packs.

## 0.32.0 (2026-09-30)

- Day and weather cycles are frozen while connected.
- New: time and weather controls, saved per location.

## 0.31.0 (2026-09-30)

- New: locations. One world can hold several scenes.
- Update the Minecraft packs.

## 0.30.2 (2026-09-30)

- Scenes line themselves up with the world automatically.

## 0.30.1 (2026-09-30)

- Fixed: a saved scene could open in the wrong place.
- New: Realign Scene with World.
- Update the Minecraft packs.

## 0.30.0 (2026-09-30)

- New: scenes are saved and linked to their Minecraft world.
- Update the Minecraft packs.

## 0.29.0 (2026-09-30)

- New variants: horse armour and markings, villager biomes and professions, llama decor.
- Camera view FOV goes from 30° to 110°.

## 0.28.0 (2026-09-30)

- New: Variant. Pick a look or baby version of a mob.
- Scan World is now Import World, and much faster.
- Update the Minecraft packs.

## 0.27.1 (2026-09-30)

- The Animation window remembers what you applied.

## 0.27.0 (2026-09-30)

- Animation works for players too, and several animations can be stacked.
- New mannequins are named Player_1, Player_2…

## 0.26.0 (2026-09-30)

- New: Animation Frame. Pose an entity from a frame of its animations.
- New: FOV slider in the camera view.

## 0.25.0 (2026-09-30)

- Cameras from Minecraft get your Minecraft FOV.
- The camera view buttons moved to the left.

## 0.24.0 (2026-09-30)

- New: move, dolly and orbit buttons in the camera view.
- Cameras are drawn as a line outline.

## 0.23.0 (2026-09-30)

- Rotating several selected things turns them around their shared centre.

## 0.22.0 (2026-09-30)

- Add Camera opens the camera view and syncs the game camera.
- Camera options are grouped under Camera.

## 0.21.0 (2026-09-30)

- Simpler menu: Skin & Equipment is one window.

## 0.20.1 (2026-09-30)

- Connect to Minecraft has a Copy Command button.

## 0.20.0 (2026-09-30)

- Pose Studio installs from GitHub and updates itself.
- New: Check for Updates and What's New.

## 0.19.3 (2026-09-30)

- Fixed: see-through and all-white parts on some entity copies.

## 0.19.2 (2026-09-30)

- Fixed: sheep bodies and cat tails.

## 0.19.1 (2026-09-30)

- Fixed: default poses of many vanilla mobs.

## 0.19.0 (2026-09-30)

- Add Entity is a floating panel that stays open.

## 0.18.1

- Earlier versions: mannequins, the live link to Minecraft, cameras, world scan, skins, entities and equipment.
