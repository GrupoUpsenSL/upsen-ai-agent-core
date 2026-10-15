import fs from "node:fs";
import path from "node:path";

/**
 * Vacía la carpeta de credenciales de Baileys SIN borrar la carpeta en sí.
 *
 * En producción /app/auth es un volumen persistente (punto de montaje): borrar la
 * carpeta entera falla con EBUSY y el bot se quedaba reintentando sin generar nunca
 * un QR nuevo. Borrando solo su contenido funciona igual con volumen y sin él.
 */
export function clearAuthDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}
