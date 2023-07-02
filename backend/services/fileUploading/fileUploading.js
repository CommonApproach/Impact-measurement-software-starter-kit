const {hasAccess} = require("../../helpers/hasAccess");
const {GDBOutcomeModel} = require("../../models/outcome");
const {GDBOrganizationModel} = require("../../models/organization");
const {GDBThemeModel} = require("../../models/theme");
const {Server400Error} = require("../../utils");
const {GDBIndicatorModel} = require("../../models/indicator");
const {getRepository} = require("../../loaders/graphDB");
const {UpdateQueryPayload,} = require('graphdb').query;
const {QueryContentType} = require('graphdb').http;
const {expand, frame} = require('jsonld');
const {GDBIndicatorReportModel} = require("../../models/indicatorReport");
const {GDBUnitOfMeasure, GDBMeasureModel} = require("../../models/measure");
const {GDBDateTimeIntervalModel, GDBInstant} = require("../../models/time");
const {getFullURI, getPrefixedURI} = require('graphdb-utils').SPARQL;

const fileUploadingHandler = async (req, res, next) => {
  try {
    if (await hasAccess(req, 'fileUploading'))
      return await fileUploading(req, res, next);
    return res.status(400).json({message: 'Wrong Auth'});
  } catch (e) {
    next(e);
  }
};

/**
 * return the first URI belongs to the object[property]
 * @param object
 * @param graphdbModel
 * @param property
 * @returns {*}
 */
const getValue = (object, graphdbModel, property) => {
  return object[getFullURI(graphdbModel.schema[property].internalKey)][0]['@value'];
};

/**
 * return list of object URI
 * @param object
 * @param graphdbModel
 * @param property
 * @returns {*}
 */
const getListOfValue = (object, graphdbModel, property) => {
  return object[getFullURI(graphdbModel.schema[property].internalKey)].map(obj => obj['@value']);
};

const getFullTypeURI = (graphdbModel) => {
  return getFullURI(graphdbModel.schemaOptions.rdfTypes[1]);
};

const getFullPropertyURI = (graphdbModel, propertyName) => {
  return getFullURI(graphdbModel.schema[propertyName].internalKey);
};

const getFullObjectURI = (object) => {
  return object["@id"];
};



async function transSave(trans, object) {
  const {query} = await object.getQueries();
  return await trans.update(new UpdateQueryPayload()
    .setQuery(query)
    .setContentType(QueryContentType.SPARQL_UPDATE)
    // .setResponseType(RDFMimeType.RDF_XML)
    // .setInference(true)
    .setTimeout(5));
}

const fileUploading = async (req, res, next) => {

  const repo = await getRepository();
  const trans = await repo.beginTransaction();
  trans.repositoryClientConfig.useGdbTokenAuthentication(repo.repositoryClientConfig.username, repo.repositoryClientConfig.pass);
  try {

    const objectDict = {};
    const outcomeDict = {};
    const themeDict = {};
    const indicatorDict = {};
    const indicatorReportDict = {};
    let traceOfUploading = ''

    function addTrace(message) {
      traceOfUploading += message + '\n';
    }

    async function outcomeBuilder(trans, object, organization) {
      const uri = object['@id'];
      const outcome = outcomeDict[uri];
      console.log( `    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`);
      addTrace(`    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`);


      // add the organization to it, and add it to the organization
      outcome.forOrganization = organization._uri;
      if (!organization.hasOutcomes)
        organization.hasOutcomes = [];
      organization.hasOutcomes.push(outcome._uri);

      // add theme to outcome
      if (!object[getFullPropertyURI(GDBOutcomeModel, 'themes')]) {
        addTrace('Error!')
        addTrace(`    ${uri}: outcome need to contain at least a Theme`)
        throw new Server400Error(traceOfUploading);
      }
      outcome.themes = getListOfValue(object, GDBOutcomeModel, 'themes');

      // add indicator to outcome
      if (!object[getFullPropertyURI(GDBOutcomeModel, 'indicators')]) {
        addTrace('Error!')
        addTrace(`    ${uri}: outcome need to contain at least an Indicator`)
        throw new Server400Error(traceOfUploading);
      }
      if (!outcome.indicators)
        outcome.indicators = [];
      for (const indicatorURI of getListOfValue(object, GDBOutcomeModel, 'indicators')) {
        outcome.indicators.push(indicatorURI);
        // add outcome to indicator
        if (!objectDict[indicatorURI]) {
          //in this case, the indicator is not in the file, get the indicator from database and add the outcome to it
          const indicator = await GDBIndicatorModel.findOne({_uri: indicatorURI});
          if (!indicator) {
            addTrace('Error!')
            addTrace(`    Indicator ${indicatorURI} appears neither in the file nor in the database`);
            throw new Server400Error(traceOfUploading);
          } //check if the indicator belongs to the organization
          if (!indicator.forOrganizations.includes(organization._uri)) {
            addTrace('Error!')
            addTrace(`    Outcome ${indicatorURI} does not belong to this organization`);
            throw new Server400Error(traceOfUploading);
          }
          if (!indicator.forOutcomes)
            indicator.forOutcomes = [];
          indicator.forOutcomes.push(uri);
          await transSave(trans, indicator);
        } // if the indicator is in the file, don't have to worry about adding the outcome to the indicator
      }
      await transSave(trans, outcome);
    }

    async function themeBuilder(trans, object, organization) {
      const uri = object['@id'];
      const theme = themeDict[uri];
      console.log( `    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`)
      addTrace(`    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`)
      await transSave(trans, theme);
    }

    async function indicatorBuilder(trans, object, organization) {
      const uri = object['@id'];
      const indicator = indicatorDict[uri];
      console.log( `    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`)
      addTrace(`    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`)

      // add the organization to it, and add it to the organization
      if (!indicator.forOrganizations)
        indicator.forOrganizations = [];
      indicator.forOrganizations.push(organization._uri);
      if (!organization.hasIndicators)
        organization.hasIndicators = [];
      organization.hasIndicators.push(indicator._uri);

      // add outcomes
      if (object[getFullPropertyURI(GDBIndicatorModel, 'forOutcomes')]) {
        if (!indicator.forOutcomes) {
          indicator.forOutcomes = [];
        }
        for (const outcomeURI of getListOfValue(object, GDBIndicatorModel, 'forOutcomes')) {
          indicator.forOutcomes.push(outcomeURI);

          if (!objectDict[outcomeURI]) {
            //in this case, the outcome is not in the file, get the outcome from database and add indicator to it
            const outcome = await GDBOutcomeModel.findOne({_uri: outcomeURI});
            if (!outcome) {
              addTrace('Error!')
              addTrace(`    Outcome ${outcomeURI} appears neither in the file nor in the database`)
              throw new Server400Error(traceOfUploading);
            }// check if the outcome belongs to the organization
            if (outcome.forOrganization !== organization._uri) {
              addTrace('Error!')
              addTrace(`    Outcome ${outcomeURI} doesn't belong to this organization`)
              throw new Server400Error(traceOfUploading);
            }
            if (!outcome.indicators)
              outcome.indicators = [];
            outcome.indicators.push(uri);
            await transSave(trans, outcome);
          } // if the outcome is in the file, don't have to worry about adding the indicator to the outcome
        }
      }

      // add indicator report
      if (object[getFullPropertyURI(GDBIndicatorModel, 'indicatorReports')]) {
        if (!indicator.indicatorReports)
          indicator.indicatorReports = [];
        getListOfValue(object, GDBIndicatorModel, 'indicatorReports').map(indicatorReportURI => {
          indicator.indicatorReports.push(indicatorReportURI);
        });
      }
      await transSave(trans, indicator);
    }

    async function indicatorReportBuilder(trans, object, organization) {
      const uri = object['@id'];
      const indicatorReport = indicatorReportDict[uri];
      console.log( `    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`);
      addTrace( `    Loading ${uri} of type ${ getPrefixedURI(object['@type'][0])}...`)
      // add the organization to it
      indicatorReport.forOrganization = organization._uri;

      // add indicator to the indicatorReport
      const indicatorURI = getValue(object, GDBIndicatorReportModel, 'forIndicator');
      indicatorReport.forIndicator = indicatorURI;

      // add the indicatorReport to indicator if needed
      if (!objectDict[indicatorURI]) {
        // the indicator is not in the file, fetch it from the database and add the indicatorReport to it
        const indicator = await GDBIndicatorModel.findOne({_uri: indicatorURI});
        if (!indicator) {
          addTrace('Error!')
          addTrace(`    Indicator ${indicatorURI} appears neither in the file nor in the database`);
          throw new Server400Error(traceOfUploading);
        }
        if (!indicator.forOrganizations.includes(organization._uri)) {
          addTrace('Error!')
          addTrace(`    Indicator ${indicatorURI} doesn't belong to this organization`)
          throw new Server400Error(traceOfUploading);
        }
        if (!indicator.indicatorReports) {
          indicator.indicatorReports = [];
        }
        indicator.indicatorReports.push(indicatorReport);
        await transSave(trans, indicator);
      }

      await transSave(trans, indicatorReport);
    }

    const {objects, organizationUri, fileName} = req.body;
    console.log(`Loading ${fileName}...`);
    addTrace(`Loading ${fileName}...`);
    if (!Array.isArray(objects)) {
      // the object should be an array
      console.log('Error');
      addTrace('Error');
      console.log('The file should contain a list.');
      addTrace('The file should contain a list.');
      throw new Server400Error(traceOfUploading);
    }
    if (!objects.length) {
      // the objects shouldn't be empty
      console.log('Warning!');
      console.log('The file is empty');
      addTrace('Warning!');
      console.log('The file is empty');
    }
    console.log('    Adding objects to organization: ' + organizationUri);
    addTrace('    Adding objects to organization: ' + organizationUri);

    const expandedObjects = await expand(objects);

    if (!expandedObjects.length) {
      console.log('Warning!');
      console.log('Got an empty list from json-ld expanded function...');
      console.log('Please check is the object a valid json-ld file: each object must contain @id and @type property. ' +
        'Some objects must contain @context if needed.');
      console.log('See more about json-ld at: https://json-ld.org/')
      addTrace('Warning!');
      addTrace('Got an empty list from json-ld expanded function...');
      addTrace('Please check is the object a valid json-ld file: each object must contain @id and @type property. ' +
        'Some objects must contain @context if needed.');
      addTrace('See more about json-ld at: https://json-ld.org/')
      throw new Server400Error(traceOfUploading);
    }


    const organization = await GDBOrganizationModel.findOne({_uri: organizationUri}, {populates: ['hasOutcomes']});
    if (!organization) {
      addTrace('Error!')
      addTrace('    Incorrect organization URI: No such Organization')
      throw new Server400Error(traceOfUploading);
    }
    for (let object of expandedObjects) {
      // store the raw object into objectDict
      const uri = object['@id'];
      objectDict[uri] = object;
      // assign the object an id and store them into specific dict
      if (object['@type'].includes(getFullTypeURI(GDBOutcomeModel))) { // todo: here don't have to be hardcoded
        if (!object[getFullPropertyURI(GDBOutcomeModel, 'name')] ||
          !object[getFullPropertyURI(GDBOutcomeModel, 'description')]
        ) {
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: name and description are mandatory`)
          throw new Server400Error(traceOfUploading);
        }
        const outcome = GDBOutcomeModel({
          name: getValue(object, GDBOutcomeModel, 'name'),
          description: getValue(object, GDBOutcomeModel, 'description'),
        }, {uri: uri});
        await transSave(trans, outcome);
        outcomeDict[uri] = outcome;
      } else if (object['@type'].includes(getFullTypeURI(GDBIndicatorModel))) {
        // if (!object[getFullPropertyURI(GDBIndicatorModel, 'name')] ||
        //   !object[getFullPropertyURI(GDBIndicatorModel, 'description')] ||
        //   !object[getFullPropertyURI(GDBIndicatorModel, 'unitOfMeasure')]) {
        //   addTrace('Error!')
        //   addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: name, description and unitOfMeasure are mandatory`)
        //   throw new Server400Error(traceOfUploading);
        // }

        if (!object[getFullPropertyURI(GDBIndicatorModel, 'name')]){
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: property ${getPrefixedURI(getFullPropertyURI(GDBIndicatorModel, 'name'))} is missing`)
          throw new Server400Error(traceOfUploading);
        }

        if (!object[getFullPropertyURI(GDBIndicatorModel, 'description')]){
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: property ${getPrefixedURI(getFullPropertyURI(GDBIndicatorModel, 'description'))} is missing`)
          throw new Server400Error(traceOfUploading);
        }

        if (!object[getFullPropertyURI(GDBIndicatorModel, 'unitOfMeasure')]){
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: property ${getPrefixedURI(getFullPropertyURI(GDBIndicatorModel, 'unitOfMeasure'))} is missing`)
          throw new Server400Error(traceOfUploading);
        }



        const indicator = GDBIndicatorModel({
          name: getValue(object, GDBIndicatorModel, 'name'),
          description: getValue(object, GDBIndicatorModel, 'description'),
          unitOfMeasure: getValue(object, GDBIndicatorModel, 'unitOfMeasure') ||
            GDBUnitOfMeasure({
                label: getValue(object[getFullPropertyURI(GDBIndicatorModel, 'unitOfMeasure')][0],
                  GDBUnitOfMeasure, 'label'
                )
              },
              {uri: getFullObjectURI(object[getFullPropertyURI(GDBIndicatorModel, 'unitOfMeasure')][0])})

        }, {uri: uri});
        await transSave(trans, indicator);
        indicatorDict[uri] = indicator;
      } else if (object['@type'].includes(getFullTypeURI(GDBIndicatorReportModel))) {
        if (!object[getFullPropertyURI(GDBIndicatorReportModel, 'name')] || !object[getFullPropertyURI(GDBIndicatorReportModel, 'dateCreated')] ||
          !object[getFullPropertyURI(GDBIndicatorReportModel, 'comment')]) {
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: name and comment are mandatory`)
          throw new Server400Error(traceOfUploading);
        }
        const indicatorReport = GDBIndicatorReportModel({
          name: getValue(object, GDBIndicatorReportModel, 'name'),
          dateCreated: new Date(getValue(object, GDBIndicatorReportModel, 'dateCreated')),
          comment: getValue(object, GDBIndicatorReportModel, 'comment'),

          value: getValue(object, GDBIndicatorReportModel, 'value') ||
            GDBMeasureModel({
                numericalValue: getValue(object[getFullPropertyURI(GDBIndicatorReportModel, 'value')][0],
                  GDBMeasureModel, 'numericalValue'
                ),
              },
              {uri: getFullObjectURI(object[getFullPropertyURI(GDBIndicatorReportModel, 'value')][0])}),

          hasTime: getValue(object, GDBIndicatorReportModel, 'hasTime') ||
            GDBDateTimeIntervalModel({

              hasBeginning: getValue(object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')][0],
                GDBDateTimeIntervalModel, 'hasBeginning') ||
                GDBInstant({
                  date: new Date(getValue(object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')][0]
                    [getFullPropertyURI(GDBDateTimeIntervalModel, 'hasBeginning')][0], GDBInstant, 'date'))
                }, {uri: getFullObjectURI(
                  object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')][0]
                    [getFullPropertyURI(GDBDateTimeIntervalModel, 'hasBeginning')][0]
                  )}),

              hasEnd: getValue(object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')][0],
                  GDBDateTimeIntervalModel, 'hasEnd') ||
                GDBInstant({
                  date: new Date(getValue(object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')][0]
                    [getFullPropertyURI(GDBDateTimeIntervalModel, 'hasEnd')][0], GDBInstant, 'date'))
                }, {uri: getFullObjectURI(
                    object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')][0]
                      [getFullPropertyURI(GDBDateTimeIntervalModel, 'hasEnd')][0]
                  )})
            }, {uri: getFullObjectURI(object[getFullPropertyURI(GDBIndicatorReportModel, 'hasTime')])})


        }, {uri: uri});
        await transSave(trans, indicatorReport);
        indicatorReportDict[uri] = indicatorReport;
      } else if (object['@type'].includes(getFullTypeURI(GDBThemeModel))) {
        if (!object[getFullPropertyURI(GDBThemeModel, 'name')] ||
          !object[getFullPropertyURI(GDBThemeModel, 'description')]) {
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: name and description are mandatory`);
          throw new Server400Error(traceOfUploading);
        }
        const theme = GDBThemeModel({
          name: getValue(object, GDBThemeModel, 'name'),
          description: getValue(object, GDBThemeModel, 'description')
        }, {uri: uri});
        await transSave(trans, theme);
        themeDict[uri] = theme;
      }  else if (object['@type'].includes(getFullTypeURI(GDBUnitOfMeasure))) {
        if (!object[getFullPropertyURI(GDBUnitOfMeasure, 'label')]) {
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: label is mandatory`)
          throw new Server400Error(traceOfUploading);
        }
        const unitOfMeasure = GDBUnitOfMeasure({
          label: getValue(object, GDBUnitOfMeasure, 'label')
        }, {uri: uri})
        await transSave(trans, unitOfMeasure);
      } else if (object['@type'].includes(getFullTypeURI(GDBMeasureModel))) {
        if (!object[getFullPropertyURI(GDBMeasureModel, 'numericalValue')]) {
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: numericalValue is mandatory`)
          throw new Server400Error(traceOfUploading);
        }
        const measure = GDBMeasureModel({
          numericalValue: getValue(object, GDBMeasureModel, 'numericalValue')
        }, {uri: uri})
        await transSave(trans, measure);
      } else if (object['@type'].includes(getFullTypeURI(GDBDateTimeIntervalModel))) {
        if (!object[getFullPropertyURI(GDBDateTimeIntervalModel, 'hasBeginning')] ||
          !object[getFullPropertyURI(GDBDateTimeIntervalModel, 'hasEnd')]) {
          addTrace('Error!')
          addTrace(`    ${uri} of Type ${ getPrefixedURI(object['@type'][0])}: hasBeginning and hasEnd is mandatory`)
          throw new Server400Error(traceOfUploading);
        }
        const dateTimeInterval = GDBDateTimeIntervalModel({
          hasBeginning: getValue(object, GDBDateTimeIntervalModel, 'hasBeginning') ||
            GDBInstant({
              date: new Date (getValue(object[getFullPropertyURI(GDBDateTimeIntervalModel, 'hasBeginning')][0],
                GDBInstant, 'date')
                )
            }),
          hasEnd: getValue(object, GDBDateTimeIntervalModel, 'hasEnd') ||
            GDBInstant({
              date: new Date (getValue(object[getFullPropertyURI(GDBDateTimeIntervalModel, 'hasEnd')][0],
                GDBInstant, 'date')
              )
            })
        }, {uri:uri});
        await transSave(trans, dateTimeInterval);
      } else {
        console.log('Warning!')
        console.log('   There is one object being ignored');
        addTrace('Warning!');
        addTrace('    There is one object being ignored');
        throw new Server400Error(traceOfUploading);
      }
    }


    for (let object of expandedObjects) {
      if (object['@type'].includes(getFullTypeURI(GDBOutcomeModel))) {
        await outcomeBuilder(trans, object, organization,);
      } else if (object['@type'].includes(getFullTypeURI(GDBIndicatorModel))) {
        await indicatorBuilder(trans, object, organization,);
      } else if (object['@type'].includes(getFullTypeURI(GDBIndicatorReportModel))) {
        await indicatorReportBuilder(trans, object, organization,);
      } else if (object['@type'].includes(getFullTypeURI(GDBThemeModel))) {
        await themeBuilder(trans, object, organization,);
      }
    }
    await transSave(trans, organization);
    // await organization.save();
    console.log('    Start to insert data...');
    addTrace('    Start to insert data...');
    await trans.commit();
    console.log(`Completed loading ${fileName}`);
    addTrace(`Completed loading ${fileName}`);
    return res.status(200).json({success: true, traceOfUploading});
  } catch (e) {
    await trans.rollback();
    next(e);
  }
};

module.exports = {fileUploadingHandler};