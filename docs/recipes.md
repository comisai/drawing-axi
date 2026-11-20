# Recipes

Tested combinations for common questions. Positions are points from the top-left corner of the sheet. Every command here is exercised by `test/contract/recipes.test.ts` against the sample sheet.

## Is this drawing readable at all?

```sh
drawing-axi info plan.pdf
drawing-axi info plan.pdf --page 2
```

A PDF page is one sheet; every command takes `--page`. Read `layers`, `labels` and `scale`. `notes` appears only when something is missing. A scan says "This page is a picture". A sheet with no layers says to split by colour. Do not measure a sheet whose scale is "not stated" without `--scale`.

## Which layer is which system?

```sh
drawing-axi legend plan.pdf
drawing-axi layers plan.pdf --limit 30
drawing-axi layers plan.pdf --split --match WATER
```

The legend gives the drawing's own words. `layers` shows what the legend leaves out. `--split` shows when one layer holds two colours; then name the colour: `WATER@#0000ff`.

If `legend` finds nothing, find the legend's place and draw a box round it:

```sh
drawing-axi labels plan.pdf --match 'legend|מקרא' --each
drawing-axi legend plan.pdf --region 1040,70,1400,200
```

## How much pipe, by size?

```sh
drawing-axi legend plan.pdf            # its box is what to leave out
drawing-axi measure plan.pdf \
  --group sewer=SEWER --group rain=RAIN --group fire=FIRE --group water=WATER@#0000ff \
  --exclude 1050,93,1360,202 --save takeoff.json
```

- Put every system in one command, so a label goes to its own pipe and not to a neighbour's.
- Exclude the legend, and a title block or detail that holds lines on the pipe layers. `legend` prints its own `box`; read other boxes off a picture with `render --grid`.
- `size_labels` says how many size labels found a run. Labels that found none belong to pipe you did not measure, or sit too far from any run.
- `unsized` rows are pipe with no label along it. Size them from riser tags or the legend, with the owner. Never guess.

## Where is that run?

```sh
drawing-axi runs plan.pdf --layer SEWER --limit 5
drawing-axi render plan.pdf --layer SEWER --region 50,150,700,650 --labels --grid --out crop.svg
resvg crop.svg crop.png
```

Then look at `crop.png`. The grid's numbers are the same coordinates the commands print.

## How many risers of each size?

```sh
drawing-axi tags plan.pdf --exclude 1000,0,1400,900
drawing-axi tags plan.pdf --each --match '^O|Ø'
```

A tag is an identifier with a size beside it. What a series letter means is in the legend or the notes: `drawing-axi labels plan.pdf --match <word>`.

## How many of this symbol?

```sh
drawing-axi symbols plan.pdf --layer SYMBOLS
drawing-axi render plan.pdf --layer SYMBOLS --region 380,300,600,400 --out symbols.svg
```

`symbols` counts groups of the same size and make-up. It does not know what they are: render one `first_at` and look.

## What does the sheet say about …?

```sh
drawing-axi labels plan.pdf --match 'פתח|opening' --each
drawing-axi labels plan.pdf --region 200,80,700,120 --each --full
drawing-axi labels plan.pdf --sizes
```

`--full` adds the text as the file stores it, wherever decoding changed it.

## The scale looks wrong

```sh
drawing-axi scale plan.pdf
drawing-axi measure plan.pdf --layer SEWER --scale 1:50
drawing-axi measure plan.pdf --layer SEWER --pt-per-m 27.78
```

To measure the factor yourself, take two points a known distance apart from `runs` or `labels --each`: points between them, divided by the metres, is `--pt-per-m`.

## A file is refused

```sh
qpdf --decrypt in.pdf out.pdf                     # encrypted
qpdf in.pdf out.pdf                               # damaged
qpdf --stream-data=uncompress in.pdf out.pdf      # unsupported filter
```

Then read `out.pdf`.

## Lines on no layer

```sh
drawing-axi layers plan.pdf --page 2
drawing-axi runs plan.pdf --page 2 --layer '(no layer)'
```

Ink that is on no layer is listed as `(no layer)`, and can be measured by that name.
