# Control de pedidos — versión 5: pagos y apartados

## Funciones nuevas

- Método de pago por movimiento:
  - Efectivo
  - Transferencia
- Fecha automática y no editable para cada pago.
- Historial de múltiples pagos o abonos.
- Cálculo automático de:
  - Total pagado
  - Saldo pendiente
  - Estatus Pagado/Apartado
- Botón “Agregar pago” dentro del detalle del pedido.
- Validación para impedir que un pago sea mayor al saldo.
- Vigencia máxima de 8 días para pedidos apartados.
- Al abrir el sistema, los apartados que superaron 8 días con saldo pendiente se cancelan automáticamente.
- Filtros:
  - Estatus del pedido
  - Estatus del pago
  - Apartados vencidos
  - Método de pago
- Excel con hoja adicional “Pagos”.
- Etiqueta con total pagado, saldo y métodos utilizados.

## Importante sobre la cancelación automática

Como el proyecto funciona en GitHub Pages y Firebase sin servidor propio, la revisión se ejecuta cuando alguien abre el sistema. Si un pedido vence mientras nadie tiene abierta la página, se cancelará la siguiente vez que el sistema se abra.

Para una cancelación exactamente a medianoche aun cuando nadie abra el sistema, se necesitaría una función programada de Firebase, que puede requerir activar facturación.

## Actualización

Reemplaza en GitHub:

- `index.html`
- `app.js`
- `styles.css`
- `README.md`

Conserva tu `firebase-config.js` actual.


## Versión 6 — Reporte de caja

Se agregó un reporte calculado con la fecha real de cada pago:

- Por día.
- Por semana.
- Por mes.
- Filtro por efectivo o transferencia.
- Total general.
- Total en efectivo.
- Total por transferencia.
- Número de movimientos.
- Tabla con fecha, folio, cliente, método, importe y vendedor.
- Exportación a Excel con hojas Resumen y Movimientos.
- Impresión del reporte.

Los abonos se registran en la caja del día en que se reciben, aunque el pedido se haya creado antes.


## Versión 7 — Lector de códigos de barras y catálogo JSON

### Cómo funciona

1. El sistema carga `inventario.json` una sola vez al abrirse.
2. Crea un índice rápido por clave o SKU.
3. Al escribir o escanear una clave y recibir Enter:
   - Busca el producto.
   - Completa automáticamente el nombre.
   - Completa el costo cuando el JSON lo contiene.
   - Coloca el cursor en costo o cantidad.
4. La cantidad y el costo todavía se pueden confirmar antes de agregar el producto al pedido.

### Archivo que debes reemplazar

Reemplaza el contenido de:

`inventario.json`

Puedes usar como referencia:

`inventario-ejemplo.json`

Formato recomendado:

```json
[
  {
    "clave": "06062026186",
    "descripcion": "Juego de utensilios de cocina",
    "categoria": "Cocina",
    "ubicacion": "Pasillo 3",
    "costo": 149.90
  }
]
```

La clave debe ser texto entre comillas para conservar ceros iniciales.

El sistema también reconoce encabezados como:

- `Clave`, `CLAVE`, `sku`, `SKU`, `codigo`, `Código`
- `descripcion`, `Descripción`, `nombre`, `Nombre`
- `costo`, `Costo`, `precio`, `Precio`

### GitHub Pages

Debes subir `inventario.json` a la misma carpeta donde están:

- `index.html`
- `app.js`
- `styles.css`

Cada vez que reemplaces el JSON en GitHub, vuelve a publicar los cambios y actualiza la página con recarga forzada.

### Rendimiento

La búsqueda utiliza `Map`, así que no recorre todo el inventario por cada lectura. Es adecuada para decenas de miles de productos. El tiempo principal ocurre solamente al descargar el JSON cuando se abre la página.


## Versión 8 — Pendiente de pago y cuadre de devoluciones

- Nuevo estatus `Pendiente de pago`, sin monto, método ni fecha inicial.
- Las devoluciones generan un ajuste financiero separado.
- Se conserva el total original, pagos recibidos y devoluciones para auditoría.
- Se calcula total ajustado, saldo pendiente y saldo a favor.
- El estatus de pago se recalcula después de cada devolución.
- Se evita devolver más piezas que las vendidas.
- Ya no se exige confirmar el reingreso en SICAR.
- Toda devolución nace con estatus `Pendiente para SICAR`.
- Excel incluye importe del ajuste y estatus de SICAR.


## Versión 9 — Liquidación obligatoria y modales persistentes

- No permite cambiar un pedido a `FINALIZADO` mientras el saldo pendiente del total ajustado sea mayor a cero.
- La validación considera pagos parciales, efectivo, transferencia y ajustes por devolución.
- El estado visual `Con repartidor` ahora aparece como `Ingresado a punto de venta`.
- Al actualizar un estatus, el modal de detalle permanece abierto y muestra una capa de carga.
- Al registrar un pago, el modal de pago permanece abierto, actualiza el saldo y muestra confirmación.
- La clave interna `CON_REPARTIDOR` se conserva para no afectar los registros existentes en Firebase.


## Versión 10 — Liquidación, punto de venta y revisión de devoluciones

- No se permite finalizar un pedido mientras tenga saldo pendiente, sin importar si los pagos fueron en efectivo, transferencia o varios abonos.
- El texto visible `Con repartidor` fue cambiado por `Ingresado a punto de venta`.
- Al actualizar un estatus, el modal permanece abierto y muestra una capa de carga.
- Al agregar un pago, el modal permanece abierto, actualiza el saldo y muestra el resultado.
- El botón de devolución ahora dice `Guardar`.
- Toda devolución nueva se registra como `Pendiente de revisión`.
- Las devoluciones pendientes muestran una casilla `Sumar devolución en inventario`.
- Para finalizar un pedido con devoluciones pendientes es obligatorio marcar dicha casilla.
- Al finalizar, las devoluciones quedan como `Revisada y sumada al inventario`.
- El cuadre financiero sigue usando el total ajustado después de devoluciones.


## Versión 11 — Flujo simplificado de devolución

El proceso de devolución queda dividido únicamente en dos pasos:

1. Registrar los productos devueltos, cantidades, motivo y observaciones.
2. Registrar la devolución en el sistema y finalizar el pedido.

Al guardar una devolución:

- El pedido cambia a `Pendiente de registrar devolución`.
- La devolución queda como `Pendiente de registrar en el sistema`.
- El importe devuelto se descuenta del total ajustado del pedido.
- Ya no existe un paso separado de revisión o suma al inventario.

Para finalizar:

- El pedido debe estar totalmente liquidado.
- Debe marcarse `Devolución registrada en el sistema`.
- Al finalizar, la devolución cambia a `Registrada en el sistema`.


## Versión 12 — Reglas de negocio de cierre, caja y pagos rápidos

- Cuando un pedido está `Finalizado`, se oculta por completo el panel para actualizar estatus.
- Las devoluciones aparecen en caja como movimientos negativos separados de los ingresos.
- El reporte muestra ingresos, devoluciones y neto de caja.
- La exportación y la impresión también separan estos movimientos.
- Al guardar correctamente un pago, el modal de pago se cierra.
- Las tarjetas con saldo pendiente tienen acceso rápido `Agregar pago`.
- Los pedidos finalizados que tuvieron devoluciones aparecen con un borde distintivo y la leyenda `Finalizado con devolución`.


## Versión 13 — Guardado de devolución y devolución total

- Al guardar correctamente una devolución, el modal se cierra.
- El detalle y la tarjeta se actualizan inmediatamente.
- `Registrar devolución` solo aparece mientras exista al menos una pieza pendiente de devolver.
- Si el pedido tenía un solo producto y se devuelve por completo, el botón desaparece.
- Si hay más productos o cantidades pendientes, el botón sigue disponible.
- Cuando todos los productos se devuelven, el total ajustado queda en cero y el pedido se considera liquidado por devolución.
- Un pedido totalmente devuelto puede finalizar sin solicitar un pago inexistente.

## Versión 14 — Vigencia, entrega e inventario

- Vigencia de apartados: 15 días.
- Al vencer, el pedido se cancela por falta de liquidación.
- El dinero aportado aparece como saldo positivo a favor del cliente.
- Se muestra la instrucción de regresar productos al inventario.
- Es obligatorio confirmar el regreso al inventario antes de finalizar.
- Tipo de entrega: punto de entrega o domicilio.
- Puntos: Naucalpan, Raza, Rosario, Cofradia, Jardines, Huilango y Azotlan.
- La etiqueta incluye el vendedor.
- Nuevo filtro: con devoluciones o sin devoluciones.


## Versión 15 — Productos acumulados y cancelaciones en caja

- Si un producto con la misma clave se agrega nuevamente al pedido, no se crea otra línea.
- La nueva cantidad se suma automáticamente a la cantidad ya registrada.
- Para productos sin clave, se consideran iguales cuando coinciden nombre y costo.
- Cuando un pedido con dinero recibido se cancela, se registra una salida negativa por el total aportado.
- La salida de cancelación usa la fecha en que el pedido fue cancelado.
- El reporte de caja separa ingresos, devoluciones y cancelaciones.
- El resumen muestra `Salidas y ajustes` y calcula el neto correctamente.


## Versión 16 — Precio original y cancelación final automática

- Cuando se agrega nuevamente el mismo código, únicamente se suma la cantidad.
- El producto conserva el nombre y el precio de la primera captura.
- Un precio diferente ingresado posteriormente no modifica las piezas ya registradas.
- Al seleccionar `Cancelar`, el pedido cambia directamente a `Finalizado · Cancelado`.
- Si había pagos o apartado, se genera la salida negativa en caja por el total recibido.
- Si no había dinero recibido, se finaliza la cancelación sin crear un movimiento negativo.
- Los apartados vencidos después de 15 días también se cancelan y finalizan automáticamente.


## Versión 17 — Almacén, Bazar y Venta rápida

- El botón `Nuevo pedido` se sustituyó por tres accesos: `Almacén`, `Bazar` y `Venta rápida`.
- Los tres flujos guardan sus pagos, devoluciones, cancelaciones y movimientos en la misma caja.
- Almacén conserva el flujo actual, pero la nomenclatura ya no se captura: se asigna automáticamente como `ALM`.
- Bazar asigna automáticamente `BAZ` y permite los estados iniciales `Clasificado`, `Entregado` y `Finalizado`.
- Venta rápida asigna automáticamente `VR`, oculta tipo de entrega y estatus del pedido, y se guarda directamente como finalizada.
- Almacén y Bazar pueden registrar devoluciones aun después de estar finalizados, siempre que no estén cancelados y todavía queden piezas disponibles para devolver.
- Las etiquetas y exportaciones identifican el tipo de operación.


## Versión 18 — Devoluciones en venta rápida

- Las ventas rápidas finalizadas también permiten registrar devoluciones.
- La devolución solo está disponible si la venta no fue cancelada.
- El botón se oculta cuando ya no quedan piezas disponibles para devolver.
- Los ajustes continúan afectando la misma caja y el mismo reporte general.


## Versión 19 — Venta rápida sin vigencia y costo de envío

- La Venta rápida no participa en la vigencia automática de 15 días.
- Como se guarda finalizada desde su creación, no muestra vencimiento ni puede cancelarse automáticamente por apartado vencido.
- Al seleccionar entrega a domicilio aparece el campo `Costo de envío`.
- El costo de envío se suma al subtotal de productos para calcular el total del pedido.
- El total actualizado se utiliza en pagos, apartados, saldos, caja, etiqueta y exportación.
- Las devoluciones descuentan el valor de los productos devueltos; el costo de envío permanece dentro del total salvo que se modifique manualmente en una versión futura.


## Versión 20 — Inicio de sesión y roles

La aplicación utiliza Firebase Authentication con correo y contraseña.

### Roles

- `admin`: acceso completo, incluyendo reporte de caja y exportaciones.
- `vendedor`: acceso a pedidos, ventas rápidas, pagos y devoluciones. No ve caja ni exportaciones.

### Configuración inicial en Firebase

1. En Firebase Console abre **Authentication → Sign-in method**.
2. Activa **Correo electrónico/contraseña**.
3. En **Authentication → Users**, crea cada cuenta.
4. Copia el `UID` de la cuenta.
5. En Firestore crea la colección `usuarios`.
6. Crea un documento cuyo ID sea exactamente el UID.

Ejemplo de administrador:

```json
{
  "nombre": "Administrador",
  "rol": "admin",
  "activo": true
}
```

Ejemplo de vendedor:

```json
{
  "nombre": "Daniela",
  "rol": "vendedor",
  "activo": true
}
```

7. Publica el archivo `firestore.rules` incluido en esta versión.

El sistema no permite elegir el rol desde el formulario de acceso. El rol se obtiene del documento autorizado en Firestore.
