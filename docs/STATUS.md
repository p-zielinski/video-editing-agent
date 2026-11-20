# Status

Not a product. A failed experiment.

The code can analyze clips, ask a model for an edit recipe, and stitch that recipe with FFmpeg. In the author's runs the MP4s were not usable edits: context from the brief was dropped, some frames came out inverted, and cuts landed in odd places.

The director's failure has a familiar shape. If you ask a model whether an email is suspicious, scores pile up around a floor near 40% for almost every message. Ordinary mail and bad mail both sit on that floor, so the score does not sort them. Asking whether a cut is interesting did the same thing here. Almost every span looked acceptable to the model, so the recipe glued clips together without a bar for what was worth keeping.

This file does not report a measured accuracy, precision, or watch-time number for the video pipeline. None was computed. The 40% figure is the shape of that email question, used as an analogy, not a result from this repo.
