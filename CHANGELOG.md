# Changelog

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
