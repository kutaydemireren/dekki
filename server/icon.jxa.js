// Run by `osascript -l JavaScript icon.jxa.js <type> <out.tiff>`: writes the macOS Finder icon for a file
// type (extension or UTI such as "public.folder") as a TIFF. Uses AppKit's NSWorkspace, the same icon
// source Finder uses. The server converts it to a small PNG with `sips`.
ObjC.import('AppKit');

function run(argv) {
  const icon = $.NSWorkspace.sharedWorkspace.iconForFileType($(argv[0]));
  icon.TIFFRepresentation.writeToFileAtomically($(argv[1]), true);
  return argv[1];
}
