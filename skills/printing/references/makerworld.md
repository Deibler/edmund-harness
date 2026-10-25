# MakerWorld

Bambu's model site. Edmund reaches it through the same cloud API Bambu
Studio uses. Bambu offers no public developer API; if these routes change,
say so rather than guessing.

## Finding something

1. `makerworld_search` with plain words ("phone stand", "articulated
   dragon"); `sort` by downloadCount for proven designs, newUploads for new.
   Look at the covers it returns. Results with many prints and likes print
   reliably.
2. `makerworld_model` on the promising ones: photos (real prints are in
   them), the license, and every print profile with its printer, time, grams
   and colors per plate. Profiles marked "fits the P2S" are made for or
   tested on it.
3. Send the person two or three options as photos (`send_attachment` with
   the saved files) with one line each: what it is, size, time, colors.

## Printing it

1. `makerworld_download` (the P2S profile if there is one). It saves the
   creator's project file.
2. `print_slice` with `model` = that file. It is re-sliced for the P2S with
   Bambu's P2S profiles; the creator's per-object settings and painted
   colors stay. The filament list maps onto the project's filaments in
   order: give the colors the person wants, or tray numbers to print with
   what is loaded.
3. Read the result like any slice (preview.md), then the normal flow.

## Altering it

| Change | How |
|---|---|
| Colors | The `filaments` list (filament 1 = the project's first color) |
| Size | `scale` (1.5 = 150%). Print-in-place joints and threads may fail below 100% |
| Orientation | `rotate_z`, `rotate_x`, `rotate_y`, or `orient: true` |
| One plate of many | `plate_index` |
| Settings | `settings` (walls, infill, supports, seam, brim...) |
| Several copies | `copies` |
| The shape itself | `makerworld_download` with `export_parts`, edit the STLs (build123d / trimesh: cut, add text, merge with your own parts), slice them as `parts`. Painted colors do not survive; assign colors by part |

## Licenses

- **Standard Digital File License** (the common one): print for yourself
  and friends; do not sell the prints or the file; do not upload remixes
  unless the model allows remixes.
- Creative Commons variants say in the name what is allowed (BY = credit,
  NC = no commercial, SA = share alike, ND = no derivatives).
- `makerworld_model` says whether remixes are allowed. Altering for a
  personal print is fine either way; publishing an alteration is not,
  unless allowed.

## Publishing (only when the approver asks)

1. Print it and take real photos (`printer_camera` at the end gives one;
   better ones from the approver's phone). MakerWorld requires at least one
   real photo of the printed model for a print profile.
2. `makerworld_package` builds the kit: project file, render, photos, and
   `listing.md` (title, summary, description, settings, tags, category,
   license). It is put on the approver's shelf.
3. Uploading is done at makerworld.com (web only; the app cannot upload)
   with the approver's account: Upload, choose Original (or Remix with the
   original linked), add the project file, fill the listing from
   listing.md, add photos, check the auto-sliced print profile, publish.
   Use the browser with the approver watching, or hand them the kit.
4. Never publish someone else's model as original, and never publish
   without the approver's explicit go-ahead for that listing.
