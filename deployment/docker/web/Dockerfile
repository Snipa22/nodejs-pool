FROM "node:8" as build

ADD build.bash /build.bash
RUN /build.bash

FROM "nginx:1.19.5"

COPY --from=build /build /www


