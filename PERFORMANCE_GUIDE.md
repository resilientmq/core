# 🚀 Guía de Rendimiento Extremo - ResilientMQ

## Procesando 500,000 Eventos Pendientes

Esta guía te ayudará a configurar ResilientMQ para procesar grandes volúmenes de eventos pendientes (500K+) de la manera más rápida posible.

## ⚡ Configuración Óptima

### 1. Configuración del Publisher

```typescript
const publisher = new ResilientEventPublisher({
    connection: 'amqp://localhost:5672',
    queue: 'your.queue',
    instantPublish: false,
    store: yourEventStore, // DEBE implementar batchUpdateEventStatus()
    
    // Configuración para máximo rendimiento
    maxConcurrentPublishes: 200,  // Aumenta según tu hardware (CPU cores * 20-30)
    idleTimeoutMs: 60000,          // Mantén la conexión abierta más tiempo
    
    // Configuración de procesamiento de pendientes
    pendingEventsBatchSize: 1000,              // Lotes grandes
    pendingEventsMaxPublishesPerSecond: 2000,  // Rate limit alto
    pendingEventsMaxConcurrentPublishes: 200   // Alta concurrencia
});
```

### 2. Llamada Optimizada a processPendingEvents

```typescript
// Procesar en lotes grandes con alta concurrencia
await publisher.processPendingEvents({
    batchSize: 1000,                    // Recupera 1000 eventos por lote
    maxPublishesPerSecond: 2000,        // Permite hasta 2000 msg/s
    maxConcurrentPublishes: 200         // 200 publicaciones en paralelo
});
```

### 3. Implementación CRÍTICA: batchUpdateEventStatus

**IMPORTANTE**: Para máximo rendimiento, tu `EventStore` DEBE implementar `batchUpdateEventStatus()`:

```typescript
class YourEventStore implements EventStore {
    // ... otros métodos ...
    
    async batchUpdateEventStatus(
        updates: Array<{ event: EventMessage; status: EventPublishStatus }>
    ): Promise<void> {
        // Ejemplo con SQL (ajusta según tu base de datos)
        const values = updates.map(u => 
            `('${u.event.messageId}', '${u.status}')`
        ).join(',');
        
        await this.db.query(`
            INSERT INTO events (message_id, status) 
            VALUES ${values}
            ON CONFLICT (message_id) 
            DO UPDATE SET status = EXCLUDED.status
        `);
        
        // O con MongoDB:
        // await this.collection.bulkWrite(
        //     updates.map(u => ({
        //         updateOne: {
        //             filter: { messageId: u.event.messageId },
        //             update: { $set: { status: u.status } }
        //         }
        //     }))
        // );
    }
}
```

## 📊 Rendimiento Esperado

Con la configuración óptima:

| Métrica | Valor |
|---------|-------|
| **Throughput** | 1000-2000 msg/s |
| **Tiempo para 500K eventos** | 4-8 minutos |
| **Llamadas al store** | ~250-500 (con batching) |
| **Uso de CPU** | Alto (esperado) |
| **Uso de memoria** | Moderado |

## 🔧 Ajustes Según Hardware

### Hardware Modesto (4 cores, 8GB RAM)
```typescript
maxConcurrentPublishes: 50
maxPublishesPerSecond: 500
batchSize: 500
```
**Tiempo estimado**: 15-20 minutos para 500K eventos

### Hardware Medio (8 cores, 16GB RAM)
```typescript
maxConcurrentPublishes: 100
maxPublishesPerSecond: 1000
batchSize: 1000
```
**Tiempo estimado**: 8-10 minutos para 500K eventos

### Hardware Potente (16+ cores, 32GB+ RAM)
```typescript
maxConcurrentPublishes: 200
maxPublishesPerSecond: 2000
batchSize: 1000
```
**Tiempo estimado**: 4-5 minutos para 500K eventos

## 🎯 Optimizaciones Implementadas (v2.1.3)

1. **Bucket size extremo**: `maxPublishesPerSecond * 3 + maxConcurrentPublishes * 5`
2. **Token refill agresivo**: Refill con ≥0.1 tokens (antes 0.5)
3. **Flush inteligente**: 100 items por batch (antes 50), intervalo de 2s (antes 1s)
4. **Esperas ultra-cortas**: 1-20ms adaptativos (antes 5-50ms)
5. **Consumo de tokens optimizado**: Permite iniciar con ≥0.1 tokens

## ⚠️ Consideraciones Importantes

### RabbitMQ
- Asegúrate de que RabbitMQ tenga suficiente memoria
- Configura `channel_max` apropiadamente
- Monitorea el uso de conexiones

### Base de Datos (EventStore)
- **CRÍTICO**: Implementa `batchUpdateEventStatus()` para evitar sobrecarga
- Usa índices en `message_id` y `status`
- Considera usar connection pooling

### Monitoreo
```typescript
// Monitorea el progreso
let processed = 0;
const total = 500000;

const interval = setInterval(async () => {
    const pending = await store.getPendingEvents(EventPublishStatus.PENDING);
    processed = total - pending.length;
    console.log(`Progreso: ${processed}/${total} (${(processed/total*100).toFixed(2)}%)`);
}, 5000);

await publisher.processPendingEvents({
    batchSize: 1000,
    maxPublishesPerSecond: 2000,
    maxConcurrentPublishes: 200
});

clearInterval(interval);
```

## 🔥 Procesamiento en Múltiples Lotes

Para volúmenes extremadamente grandes, procesa en múltiples llamadas:

```typescript
async function processAllPending() {
    let hasMore = true;
    let totalProcessed = 0;
    
    while (hasMore) {
        const startTime = Date.now();
        
        await publisher.processPendingEvents({
            batchSize: 1000,
            maxPublishesPerSecond: 2000,
            maxConcurrentPublishes: 200
        });
        
        const elapsed = Date.now() - startTime;
        
        // Verifica si quedan más eventos
        const remaining = await store.getPendingEvents(EventPublishStatus.PENDING);
        hasMore = remaining.length > 0;
        totalProcessed += 1000;
        
        console.log(`Procesados: ${totalProcessed}, Tiempo: ${elapsed}ms, Quedan: ${remaining.length}`);
        
        // Pequeña pausa para evitar sobrecarga
        if (hasMore) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}
```

## 📈 Métricas de Rendimiento

```typescript
const metrics = publisher.getMetrics();
console.log({
    messagesPublished: metrics.messagesPublished,
    processingErrors: metrics.processingErrors,
    avgProcessingTimeMs: metrics.avgProcessingTimeMs
});
```

## 🎓 Tips Adicionales

1. **Ejecuta durante horas de baja carga** si es posible
2. **Monitorea RabbitMQ** para evitar saturación
3. **Usa batch updates** en tu EventStore (90% más rápido)
4. **Ajusta según resultados** - empieza conservador y aumenta gradualmente
5. **Ten un plan de rollback** por si algo falla

## 🆘 Troubleshooting

### "Muy lento (< 100 msg/s)"
- ✅ Verifica que implementaste `batchUpdateEventStatus()`
- ✅ Aumenta `maxConcurrentPublishes`
- ✅ Verifica que RabbitMQ no esté saturado

### "Errores de conexión"
- ✅ Reduce `maxConcurrentPublishes`
- ✅ Aumenta `idleTimeoutMs`
- ✅ Verifica límites de RabbitMQ

### "Alto uso de memoria"
- ✅ Reduce `batchSize`
- ✅ Reduce `maxConcurrentPublishes`
- ✅ Procesa en múltiples lotes más pequeños

---

**Versión**: 2.1.3  
**Última actualización**: 2026-03-31
