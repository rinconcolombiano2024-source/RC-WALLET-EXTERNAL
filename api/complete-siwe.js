import verifySiweHandler from "./verify-siwe.js";

export default async function handler(req, res) {
  return verifySiweHandler(req, res);
}
