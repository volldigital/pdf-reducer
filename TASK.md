# PDF file size reducer

In an application, the user can upload PDF files.
As they most likely "scan" documents using their phone, the PDFs get rather large.

The goal is, to write a "helper" Javascript file, that contains all the logic required to reduce the file size of a pdf.

## Environment

* The language is Javascript.
* The PDF is available as base64 encoded string.
* The PDF needs to be returned as a base64 encoded string.
* Libraries can and should be used, wherever possible.
Licenses must be considered carefully as this is a commercial application. Ghostscript for example, with its AGPL license, is out of the question.

## Technical details

* The output of this should be a `pdfSizeReducer.js`.
* It should expose one method `reduce` that takes a string containing a base64 encoded PDF as parameter and returns a string containing the reduced PDF as base64 encoded string.

## Tasks

1. Research adequate libraries that help with implementing the reducer.
2. Consider pros and cons of each library.
3. Offer an overview of the resulting approaches, listing the pros and cons for me to decide which approach to continue with.
4. Refine the approach together with me.
5. Write up a plan for implementing the approach.
6. Execute the plan step by step, waiting for my approval at each step.

## General rules

* Never just assume things. Research thoroughly and ask me questions if something is unclear or ambiguous.
* Never jump the the next step without me approving the current step.
I might want to review the results of the current step and apply slight changes that could affect the remaining plan.
* Always document your progress.
* Always document decisions that were made.
* Update decisions if they change, document _why_ it changed so the decision making process can be reviewed at a later time.
