# GitHub Workflows

Este directorio contiene los workflows de GitHub Actions para CI/CD automatizado.

## Workflow: CI/CD Pipeline (`ci-cd.yml`)

Pipeline unificado que maneja testing, build y publicación a npm.

### Jobs y Dependencias

```
unit-tests (Node 18, 20, 22)
    ↓
integration-tests (Node 18, 20, 22)
    ↓
build (solo si tests pasan)
    ↓
publish (solo en master, si tests y build pasan)
    ↓
test-summary (siempre se ejecuta)
```

### Triggers

- **Push** a branches: `main`, `master`, `develop`
- **Pull Request** a branches: `main`, `master`, `develop`

### Jobs

#### 1. Unit Tests
- Ejecuta en Node.js 18, 20 y 22
- Corre tests unitarios con cobertura
- Verifica que la cobertura sea >= 70%
- Sube reportes de cobertura y resultados

#### 2. Integration Tests
- Ejecuta en Node.js 18, 20 y 22
- Levanta RabbitMQ como servicio
- Espera hasta 120 segundos para que RabbitMQ esté listo
- Corre tests de integración
- Sube resultados de tests

#### 3. Build
- Solo se ejecuta si unit-tests e integration-tests pasan
- Compila el proyecto TypeScript
- Verifica la estructura del paquete
- Sube artefactos de build

#### 4. Publish to NPM
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

#### 5. Test Summary
- Siempre se ejecuta (incluso si hay fallos)
- Genera resumen de resultados en GitHub

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



