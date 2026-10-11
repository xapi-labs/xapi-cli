interface Env { PUBLIC_LABEL: string; JSON_VALUE?: { answer: number } }
function label(env: Env): string { return `fixture:${env.PUBLIC_LABEL}`; }
export default { async fetch(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname === "/throw") throw new Error("native-map-fixture");
  console.log(label(env)); return Response.json({label:label(env),config:env.JSON_VALUE});
}};
