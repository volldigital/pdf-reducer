# Open sourcing this repository

I want to open source this repository.
Help me create a plan on things that have to happen beforehand and the actual steps required.
Add the plan to the repository itself, so other sessions / developers might participate.
Tell me where I might have missed something that is relevant.

## Rough constraints
* the code will be hosted on GitHub
* I want to do trunk based development
  * `main` branch - is supposed to be deployed to an artifact repository on push, for usage via npm in other projects
  * `feature/*` branches - are being used to implement new features, improvements or bugfixes - should only be built and/or tested on push
* The previous bullet points imply that GitHub actions will be used with "on push" triggers. 
* I want the most permissive license possible, given the current dependencies

## Open questions
1. What licenses can be used? List possible licenses and compare them.
2. Where will the final artifact be hosted? Are there multiple options? What are pros and cons?
3. Is there something missing from the repository that a _good_ open source project should have?
4. Is it smart to deploy the artifact due to a push on `main` or should this be a manual action?
5. What are other things to consider, that I might have missed?
