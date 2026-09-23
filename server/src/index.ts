import express from "express";

const app = express();

app.get("/health", (_request, response) => {
  response.json({ status: "running" });
});

const port = Number(process.env.PORT ?? 3001);

app.listen(port, () => {
  console.log(`Bussin server listening on port ${port}`);
});
