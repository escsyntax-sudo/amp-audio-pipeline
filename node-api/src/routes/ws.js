export async function websocketRoutes(app, { bus }) {
  app.get("/ws", { websocket: true }, (socket, request) => {
    let payload;
    try {
      payload = app.jwt.verify(request.query?.token ?? "");
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
      socket.close(4401, "unauthorized");
      return;
    }

    const unsubscribe = bus.subscribe(payload.sub, (event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    socket.send(JSON.stringify({ type: "ws.ready", userId: payload.sub }));
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, 30_000);

    socket.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    socket.on("error", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
