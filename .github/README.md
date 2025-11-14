# GitHub Workflows

Este directorio contiene los workflows de GitHub Actions para CI/CD automatizado.

## Workflow: CI/CD Pipeline (`ci-cd.yml`)

Pipeline unificado que maneja testing, build y publicación a npm.

### Jobs y Dependencias

```
unit-tests (Node 18, 20, 22, 24)
    ↓
integration-tests (Node 18, 20, 22, 24)
    ↓
    ├─→ stress-tests
    └─→ benchmarks
         ↓
       build (solo si todos los tests pasan)
         ↓
      publish (solo en master, si todo pasa)
         ↓
    test-summary (siempre se ejecuta, con detalles completos)
```

### Triggers

- **Push** a branches: `main`, `master`, `develop`
- **Pull Request** a branches: `main`, `master`, `develop`

### Jobs

#### 1. Unit Tests
- Ejecuta en Node.js 18, 20, 22 y 24
- Corre tests unitarios con cobertura
- Verifica que la cobertura sea >= 70%
- Sube reportes de cobertura y resultados

#### 2. Integration Tests
- Ejecuta en Node.js 18, 20, 22 y 24
- Levanta RabbitMQ como servicio
- Espera hasta 60 segundos para que RabbitMQ esté listo
- Corre tests de integración
- Sube resultados de tests

#### 3. Stress Tests
- Solo se ejecuta si unit-tests e integration-tests pasan
- Levanta RabbitMQ como servicio
- Ejecuta tests de estrés del sistema
- Valida métricas de calidad:
  - Error rate debe ser < 1%
  - Throughput debe cumplir mínimos
- Sube resultados de stress tests

#### 4. Benchmarks
- Solo se ejecuta si unit-tests e integration-tests pasan
- Levanta RabbitMQ como servicio
- Ejecuta benchmarks de rendimiento
- Valida umbrales de performance:
  - Throughput mínimo: 100 msg/s
  - Latencia máxima promedio: 100 ms
- Compara con benchmarks anteriores
- Sube resultados de benchmarks

#### 5. Build
- Solo se ejecuta si todos los tests pasan (unit, integration, stress, benchmarks)
- Compila el proyecto TypeScript
- Verifica la estructura del paquete
- Sube artefactos de build

#### 6. Publish to NPM
- **Solo se ejecuta en branch `master`**
- **Solo si todos los tests y build pasan**
- Descarga artefactos de build
- Verifica cambios en carpeta `src/`
- Verifica si la versión ya existe en npm
- Crea tag de git si es necesario
- Publica a npm si:
  - ✅ Hay cambios en `src/`
  - ✅ La versión no existe en npm
  - ✅ Todos los tests pasaron

#### 7. Test Summary
- Siempre se ejecuta (incluso si hay fallos)
- Descarga todos los artefactos generados
- Genera resumen detallado con:
  - **Información del workflow**: Branch, commit, trigger
  - **Estado de cada job**: Unit, Integration, Stress, Benchmarks, Build
  - **Métricas de stress tests**: Throughput, error rate, mensajes procesados
  - **Resultados de benchmarks**: Throughput, latencia promedio
  - **Reporte de cobertura**: Tabla con lines, branches, functions, statements
  - **Resultado final**: Resumen de jobs fallidos y estado general
  - **Lista de artefactos**: Disponibles para descarga
- Falla si algún job requerido falló
- Muestra mensaje de "Ready for publish" si está en master y todo pasó

### Variables de Entorno Requeridas

#### Secrets
- `NPM_TOKEN`: Token de npm para publicación (solo para job de publish)
- `GITHUB_TOKEN`: Automáticamente provisto por GitHub Actions

### Configuración de RabbitMQ

Los integration tests usan RabbitMQ como servicio con:
- Puerto AMQP: 5672
- Puerto Management: 15672
- Health checks cada 10s
- Timeout de 5s
- 10 reintentos
- Start period de 30s

### Artefactos Generados

- **coverage-report**: Reportes de cobertura (30 días)
- **unit-test-results**: Resultados de tests unitarios (30 días)
- **integration-test-results**: Resultados de tests de integración (30 días)
- **build-artifacts**: Archivos compilados (7 días)

### Notas

- Los tests unitarios no requieren RabbitMQ
- Los tests de integración esperan hasta 120 segundos para RabbitMQ
- El publish solo ocurre en `master` después de que todos los tests pasen
- Si no hay cambios en `src/`, no se publica aunque la versión sea nueva



