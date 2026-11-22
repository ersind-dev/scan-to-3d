# Scan to 3D Model

Turn MRI and CT scans into a 3D model you can rotate, cut open and save as STL, right in your browser.

**Open the app:** https://ersind-dev.github.io/scan-to-3d/

Your files are read on your own device. Nothing is uploaded anywhere.

> **Not a medical device.** This is for looking at and 3D-printing scans. Do not use it to diagnose anything.

## What it reads

| Format | How to load it |
|---|---|
| DICOM (`.dcm`, GE `.MRDC`, files with no extension) | Select every file in the series, the whole folder, or a `.zip` |
| NIfTI (`.nii`, `.nii.gz`) | Select the file |
| JPG / PNG slices | Name them as below, then select them all or a `.zip` |

If a folder holds several series, the app lists them and shows the one with the most slices first.

## Naming JPG / PNG slices

Images have no size or position information, so the app needs the names and sizes from you.

- Name each slice `axial_0001.jpg`, `sagittal_0001.jpg` or `coronal_0001.jpg`.
- Number axial from head to feet, sagittal from the patient's left side to the right, coronal from front to back.
- Use normal radiology display: the patient's right side on the image's left.
- Coloured overlays such as orientation icons are removed automatically.

Add a `scan-info.txt` next to the images so the proportions are right (or type the values into the app):

```text
pixel_mm = 0.437
axial_gap_mm = 1.00
sagittal_gap_mm = 1.35
coronal_gap_mm = 1.30
```

`pixel_mm` is the size of one image pixel. Each `*_gap_mm` is the distance between two neighbouring images in that view, which is not always the scanner's slice thickness. Screen recordings often skip slices.

## Using the app

1. **Scan:** choose your files, or try the built-in sample shape.
2. **Surface:** set the brightness level that becomes solid. Low shows skin; around 200 shows bone on CT.
3. **Cut open:** slide a cut plane through the model. The cut face shows the original scan image.
4. **Save:** download the model as STL, in millimetres, for Blender or a 3D printer.

MRI shows bone poorly. Thin, evenly spaced slices (about 1 mm) give the smoothest models.

## Building it yourself

The app is plain JavaScript bundled into one file, `app.js`. You need Node.js 18 or newer.

```bash
npm install
npm run build
```

Then open `index.html`, or serve the folder with any static web server.

To run the tests (Python 3 with `numpy` and `pydicom` makes a synthetic test scan):

```bash
npm run test:data
npm test
```

## How it works

- `src/volume.js` reads DICOM, NIfTI and image stacks into one 8-bit volume with millimetre spacing and orientation.
- `src/mesh.js` builds the surface with naive surface nets and writes binary STL.
- `src/main.js` is the viewer, built on three.js.

## Contributing

Bug reports and pull requests are welcome. Please never attach real patient scans to an issue: they are personal health data. Describe the problem, or share a scan with all personal details removed.

## Licence

MIT. See [LICENSE](LICENSE). It uses [three.js](https://threejs.org), [daikon](https://github.com/rii-mango/Daikon), [nifti-reader-js](https://github.com/rii-mango/NIFTI-Reader-JS) and [fflate](https://github.com/101arrowz/fflate), all MIT.
