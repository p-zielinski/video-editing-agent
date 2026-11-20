# Status

Lab dump, not a product.

The code can analyze clips, ask a model for an edit recipe, and stitch that recipe with FFmpeg. In the author's runs the MP4s were not usable edits. The known failure is not a single inverted-frame FFmpeg flag. Flipped frames are a symptom. The structural hole is in the director.

The director has no bar that can say a cut is not interesting. Spans that barely qualify still enter the recipe, so the timeline glues. It keeps almost everything that fits the schema instead of leaving most of it out.

That behavior has a familiar shape. If you ask a model whether an email is suspicious, scores pile up around a floor near 40% for almost every message. Ordinary mail and bad mail both sit on that floor, so the score does not sort them. Asking whether a cut is interesting did the same here. Almost every span looked acceptable to the model, so the recipe filled up without a working rejection test.

An automaton built this way will not replace an editor on a production that can pay one. Style and pacing are not learnable from a one-off batch and a brief on the command line. Trends would have to be fed from outside, continuously, and wired into every decision. This tree does not do that.

This file does not report measured accuracy, precision, or watch-time numbers for the video pipeline. None was computed. The 40% figure is the shape of that email question, used as an analogy, not a result from this repo. Nothing in this note promises a code fix.