What was created

- ax-icon-foreground.svg    -> vector foreground (transparent background)
- ax-icon-background.svg    -> black rounded-square 512x512 (background)
- android-adaptive-icon-snippet.xml -> adaptive-icon XML snippet for Android

Goal

These files let you produce Android launcher PNGs (mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi) and integrate an adaptive icon so the app icon matches the home screen style.

Recommended densities / sizes (Android launcher):
- mdpi   = 48x48
- hdpi   = 72x72
- xhdpi  = 96x96
- xxhdpi = 144x144
- xxxhdpi= 192x192

Commands (Windows) — Inkscape (recommended local vector->PNG):

# Example (PowerShell) using Inkscape (Inkscape 1.0+ CLI):
# Change directory to this project folder first, or use full paths
# Syntax: inkscape.exe -w <width> -h <height> <input.svg> -o <output.png>

inkscape.exe -w 48  -h 48  .\ax-icon-foreground.svg -o .\launcher-mdpi-foreground-48.png
inkscape.exe -w 72  -h 72  .\ax-icon-foreground.svg -o .\launcher-hdpi-foreground-72.png
inkscape.exe -w 96  -h 96  .\ax-icon-foreground.svg -o .\launcher-xhdpi-foreground-96.png
inkscape.exe -w 144 -h 144 .\ax-icon-foreground.svg -o .\launcher-xxhdpi-foreground-144.png
inkscape.exe -w 192 -h 192 .\ax-icon-foreground.svg -o .\launcher-xxxhdpi-foreground-192.png

# Do the same for background (if you want flattened PNGs):
inkscape.exe -w 48 -h 48  .\ax-icon-background.svg -o .\launcher-mdpi-background-48.png
# etc.

Commands (Windows) — ImageMagick (if installed):
# magick is the ImageMagick entrypoint
magick -background none -resize 48x48 .\ax-icon-foreground.svg .\launcher-mdpi-foreground-48.png

Notes about adaptive icons and flattening

1) Adaptive icon recommended: keep foreground as a vector (ax-icon-foreground.svg) and background as a separate drawable (ax-icon-background.svg or a solid color). Android will layer them and apply system masks.

2) If you need PNGs instead of drawables, rasterize both foreground and background to PNGs at each density and place them into res/drawable-<density> (or res/mipmap-<density>) as needed.

Android integration (quick steps)

1. Put the adaptive icon XML (android-adaptive-icon-snippet.xml) into:
   res/mipmap-anydpi-v26/ic_launcher.xml
   and optionally res/mipmap-anydpi-v26/ic_launcher_round.xml

2. Provide the foreground and background drawables referenced by that file. Options:
   - Use vector drawables: convert foreground SVG into res/drawable/ic_launcher_foreground.xml (Android VectorDrawable conversion required)
   - Or raster PNGs: create PNGs at densities and add them as @drawable/ic_launcher_foreground (or place PNGs directly in mipmap folders and reference them)

3. Update AndroidManifest application icon (usually already uses @mipmap/ic_launcher).

Testing on device

- Install the updated APK on device. If the launcher cache shows the old icon, try:
  - Uninstall and reinstall the app
  - Or clear the launcher app cache via Settings -> Apps -> (your launcher) -> Storage -> Clear cache/data (device dependent)
  - Reboot device if needed

Optional: preview on your home-screen screenshot

If you want, I can place a generated PNG into the screenshot you provided to show exactly how it will look on your home screen. Say "preview" and I will create a mockup (I will rasterize a PNG here and place it on the screenshot).

If you prefer, I can also produce a zip of final PNGs (if local tools on this environment can rasterize). Otherwise follow the Inkscape/ImageMagick commands above on your machine to produce PNGs quickly.

If you'd like me to produce the flattened PNGs here and a mockup, reply: "Please rasterize and preview" and I'll attempt to rasterize and place the icon on your screenshot.

