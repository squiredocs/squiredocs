# Image-Bearing Document

An external image:

![diagram](https://images.example.com/diagram.png)

The same external image referenced again:

![diagram again](https://images.example.com/diagram.png)

A second distinct external image over plain http:

![chart](http://images.example.com/chart.gif)

A data URL image:

![embedded pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)

A data URL image with no alt text:

![](data:image/gif;base64,R0lGODlhAQABAAAAACw=)

An app-URL image (same-doc placeholder, rewritten by tests):

![existing](/api/docs/SAME_DOC_ID/images/SAME_IMAGE_ID)

A cross-doc app-URL image (placeholder, rewritten by tests):

![other doc](/api/docs/OTHER_DOC_ID/images/OTHER_IMAGE_ID)

Closing paragraph.
