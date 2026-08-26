# Combine Fields

Builds a new field as a **weighted sum of the fields that are currently loaded** —
`result = w₁ × field₁ + w₂ × field₂ + …`


**Create field** adds the result under a **Derived** group in the list above and selects it
immediately. It is an ordinary field from then on: isosurface, cut planes, tracers and the colour
controls all treat it like anything read from a file, and it can itself be a term in a further
combination.


## Limits

The result is a new full-size grid held in memory, so building many combinations of a large file
costs real memory. If too many are made, old fields may be forcefully dropped out of memory, but can be loaded back when desired.
